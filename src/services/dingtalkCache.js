const { pool } = require('../db');

/* ============================================================
 * 时区工具
 * ============================================================ */

const BJ_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 毫秒时间戳 → "YYYY-MM-DD HH:mm:ss"（北京时间） */
function tsToLocalString(ts) {
  if (ts === null || ts === undefined) return null;
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return null;
  const parts = BJ_FORMATTER.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get(
    'minute'
  )}:${get('second')}`;
}

/** 任意时间输入 → "YYYY-MM-DD HH:mm:ss"（北京时间） */
function normalizeDbTimeString(v) {
  if (!v) return null;
  if (v instanceof Date) return tsToLocalString(v.getTime());

  const s = String(v).trim().replace(/\//g, '-');
  if (!s) return null;

  // 已经是标准格式，直接返回
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(s)) return `${s}:00`;
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(s)) return s;

  // ⭐ 处理 ISO 8601 带时区格式，如 "2026-09-08T03:39:07.000Z"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return tsToLocalString(d.getTime());
  }

  // 其它格式：按北京时间解析
  const d = new Date(s.replace(' ', 'T') + '+08:00');
  if (isNaN(d.getTime())) return null;
  return tsToLocalString(d.getTime());
}

/** 判断是否终态 */
function isFinalStatus(status) {
  if (status === null || status === undefined) return false;
  const v = String(status).trim().toUpperCase();
  return v === 'COMPLETED';
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function safeParse(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function rowToItem(row) {
  const p = safeParse(row.payload) || {};
  return {
    templateName: row.template_name,
    processCode: row.process_code,
    processInstanceId: row.process_instance_id,
    title: row.title,
    status: row.status,
    result: row.result,
    // ⭐ 统一格式化为 "YYYY-MM-DD HH:mm:ss"
    createTime: normalizeDbTimeString(row.create_time) || '',
    finishTime: normalizeDbTimeString(row.finish_time) || undefined,
    paymentUnit: row.payment_unit,
    payeeAccount: row.payee_account,
    amount: row.amount != null ? String(row.amount) : null,
    items: p.items || [],
    formValues: p.formValues || {},
    operationRecords: p.operationRecords || [],
    originatorName: p.originatorName || '',
    pendingApprovers: p.pendingApprovers || [],
    error: p.error,
    _fromCache: true,
  };
}

/* ============================================================
 * 从缓存读：时间段内 is_final=1 的记录
 * ============================================================ */
async function getCachedFinals(startTs, endTs, processCodes) {
  if (!startTs || !endTs) return [];

  const startStr = tsToLocalString(startTs);
  const endStr = tsToLocalString(endTs);
  if (!startStr || !endStr) return [];

  let sql = `
    SELECT process_instance_id, template_name, process_code,
           title, status, result, create_time, finish_time,
           payment_unit, payee_account, amount, payload, is_final
      FROM dingtalk_process_cache
     WHERE create_time BETWEEN ? AND ?
       AND is_final = 1
  `;
  const params = [startStr, endStr];

  if (Array.isArray(processCodes) && processCodes.length > 0) {
    const placeholders = processCodes.map(() => '?').join(',');
    /* ⭐ 兼容旧数据：process_code 为 NULL 的也算 */
    sql += ` AND (process_code IN (${placeholders}) OR process_code IS NULL)`;
    params.push(...processCodes);
  }

  const [rows] = await pool.query(sql, params);
  console.log(
    `[dingtalkCache] getCachedFinals 范围 ${startStr} ~ ${endStr}，命中 ${rows.length} 条`
  );
  return rows.map(rowToItem);
}

/* ============================================================
 * 从缓存读：指定 ID 列表中"已是 final"的 ID
 * ============================================================ */
async function getFinalIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return new Set();

  const out = new Set();
  const CHUNK = 500;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT process_instance_id
         FROM dingtalk_process_cache
        WHERE process_instance_id IN (${placeholders})
          AND is_final = 1`,
      slice
    );
    rows.forEach((r) => out.add(r.process_instance_id));
  }
  return out;
}

/* ============================================================
 * 批量写入 / 更新
 * ============================================================ */
async function upsertMany(items, templateName, processCode) {
  if (!Array.isArray(items) || items.length === 0) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let finalCount = 0;

    for (const it of items) {
      if (!it.processInstanceId) continue;

      const isFinal = isFinalStatus(it.status) ? 1 : 0;
      if (isFinal) finalCount++;

      const payload = {
        formValues: it.formValues || {},
        items: it.items || [],
        operationRecords: it.operationRecords || [],
        originatorName: it.originatorName || '',
        pendingApprovers: it.pendingApprovers || [],
        error: it.error,
      };

      const createTime = normalizeDbTimeString(it.createTime);
      const finishTime = normalizeDbTimeString(it.finishTime);

      /* ⭐ 三个字段都优先用 item 自带的，再看参数，最后 null */
      const finalTemplateName = it.templateName || templateName || null;
      const finalProcessCode = it.processCode || processCode || null;

      await conn.query(
        `INSERT INTO dingtalk_process_cache
          (process_instance_id, template_name, process_code,
           title, status, result, create_time, finish_time,
           payment_unit, payee_account, amount, payload,
           is_final, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           template_name  = VALUES(template_name),
           process_code   = VALUES(process_code),
           title          = VALUES(title),
           status         = VALUES(status),
           result         = VALUES(result),
           create_time    = VALUES(create_time),
           finish_time    = VALUES(finish_time),
           payment_unit   = VALUES(payment_unit),
           payee_account  = VALUES(payee_account),
           amount         = VALUES(amount),
           payload        = VALUES(payload),
           is_final       = VALUES(is_final),
           last_synced_at = NOW()`,
        [
          it.processInstanceId,
          finalTemplateName,
          finalProcessCode,
          it.title || null,
          it.status || null,
          it.result || null,
          createTime,
          finishTime,
          it.paymentUnit || null,
          it.payeeAccount || null,
          toNumberOrNull(it.amount),
          JSON.stringify(payload),
          isFinal,
        ]
      );
    }

    await conn.commit();
    console.log(
      `[dingtalkCache] upsertMany 完成：共 ${items.length} 条，其中 final ${finalCount} 条`
    );
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  getCachedFinals,
  getFinalIds,
  upsertMany,
  tsToLocalString,
  normalizeDbTimeString,
  isFinalStatus,
};