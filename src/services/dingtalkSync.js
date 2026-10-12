const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const cache = require('./dingtalkCache');

const DINGTALK_APP_KEY = process.env.DINGTALK_APP_KEY;
const DINGTALK_APP_SECRET = process.env.DINGTALK_APP_SECRET;

let timer = null;
let running = false;

/* ============================================================
 * ⭐ 会员退费：门店 → 第一家公司 映射
 * ============================================================ */
const STORE_COMPANY_MAP = {
  '富贵园店': '北京林朗韵动体育管理有限公司',
  '哈德门店': '北京林朗悦动体育管理有限公司',
};

/** 会员退费模板名 */
const MEMBER_REFUND_TEMPLATE = '会员退费';

/** ⭐ 生效起始日期（含），会员退费 10 月起新增「门店」字段 */
const MEMBER_REFUND_EFFECTIVE_FROM = '2026-10-01';

/** 门店字段可能的 key（按优先级） */
const STORE_FIELD_KEYS = ['门店', '所属门店', '门店名称', '校区'];

/* ============================================================
 * 时间工具
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

function nowBeijingString() {
  const parts = BJ_FORMATTER.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get(
    'minute'
  )}:${get('second')}`;
}

/** "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm:ss" → Date（按北京时间） */
function parseBeijingDate(s) {
  if (!s) return null;
  const str = String(s).trim().replace(/\//g, '-');
  const d = new Date(str.replace(' ', 'T') + '+08:00');
  return isNaN(d.getTime()) ? null : d;
}

/** ⭐ 判断是否在会员退费「门店字段生效」之后 */
function isAfterMemberRefundEffective(createTime) {
  const d = parseBeijingDate(createTime);
  if (!d) return false;
  const start = parseBeijingDate(MEMBER_REFUND_EFFECTIVE_FROM + ' 00:00:00');
  if (!start) return false;
  return d.getTime() >= start.getTime();
}

/* ============================================================
 * ⭐ 门店归属
 * ============================================================ */
function extractStoreName(formValues) {
  if (!formValues || typeof formValues !== 'object') return null;
  for (const k of STORE_FIELD_KEYS) {
    const v = formValues[k];
    if (
      v !== undefined &&
      v !== null &&
      String(v).trim() !== '' &&
      v !== 'null'
    ) {
      return String(v).trim();
    }
  }
  return null;
}

function mapStoreToCompany(storeName) {
  if (!storeName) return null;
  if (STORE_COMPANY_MAP[storeName]) return STORE_COMPANY_MAP[storeName];
  const hit = Object.keys(STORE_COMPANY_MAP).find(
    (k) => storeName.includes(k) || k.includes(storeName)
  );
  return hit ? STORE_COMPANY_MAP[hit] : null;
}

/**
 * ⭐ 会员退费：按门店字段重算 paymentUnit
 *    返回 { paymentUnit, autoAssigned, storeName, reason }
 */
function resolveMemberRefundPaymentUnit(
  templateName,
  formValues,
  originalPaymentUnit,
  createTime
) {
  const fallback = {
    paymentUnit: originalPaymentUnit,
    autoAssigned: false,
    storeName: null,
    reason: '',
  };

  if (templateName !== MEMBER_REFUND_TEMPLATE) {
    return { ...fallback, reason: 'not-member-refund' };
  }
  if (!isAfterMemberRefundEffective(createTime)) {
    return { ...fallback, reason: 'before-effective' };
  }

  const storeName = extractStoreName(formValues);
  if (!storeName) {
    return { ...fallback, reason: 'no-store-field' };
  }

  const company = mapStoreToCompany(storeName);
  if (!company) {
    console.warn(
      `[DingTalkSync] 会员退费门店「${storeName}」未在 STORE_COMPANY_MAP 配置，保持原付款单位`
    );
    return { ...fallback, storeName, reason: 'no-mapping' };
  }

  return {
    paymentUnit: company,
    autoAssigned: true,
    storeName,
    reason: 'ok',
  };
}

/* ============================================================
 * 配置读写
 * ============================================================ */
async function getConfig() {
  const [rows] = await pool.query(
    `SELECT * FROM dingtalk_sync_config WHERE id = 1 LIMIT 1`
  );
  if (rows.length === 0) {
    return {
      enabled: true,
      schedule_mode: 'daily',
      daily_hour: 3,
      interval_hours: 6,
      lookback_days: 30,
      last_run_at: null,
      last_run_status: null,
      last_run_message: null,
    };
  }
  const cfg = rows[0];
  return {
    ...cfg,
    last_run_at: cache.normalizeDbTimeString(cfg.last_run_at),
  };
}

async function updateConfig(patch) {
  const allowed = [
    'enabled',
    'schedule_mode',
    'daily_hour',
    'interval_hours',
    'lookback_days',
  ];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      params.push(patch[k]);
    }
  }
  if (sets.length === 0) return;

  params.push(1);
  await pool.query(
    `UPDATE dingtalk_sync_config SET ${sets.join(', ')} WHERE id = ?`,
    params
  );
}

async function markRun(status, message) {
  const nowStr = nowBeijingString();
  await pool.query(
    `UPDATE dingtalk_sync_config
        SET last_run_at = ?,
            last_run_status = ?,
            last_run_message = ?
      WHERE id = 1`,
    [nowStr, status, message ? String(message).slice(0, 500) : null]
  );
}

/**
 * ⭐ 清理上次进程被杀 / 崩溃时残留的 running 状态
 *    在 startDingTalkSync 时调用一次即可
 */
async function resetStaleRunningState() {
  try {
    const [rows] = await pool.query(
      `SELECT last_run_status FROM dingtalk_sync_config WHERE id = 1 LIMIT 1`
    );
    const status = rows?.[0]?.last_run_status;
    if (status === 'running') {
      await pool.query(
        `UPDATE dingtalk_sync_config
            SET last_run_status = 'failed',
                last_run_message = CONCAT(
                  IFNULL(last_run_message, ''),
                  ' [服务重启，上次同步未正常结束]'
                )
          WHERE id = 1`
      );
      console.log('[DingTalkSync] 检测到残留 running 状态，已重置为 failed');
    }
  } catch (e) {
    console.warn('[DingTalkSync] resetStaleRunningState 失败', e.message);
  }
}

/* ============================================================
 * 钉钉 API
 * ============================================================ */
async function getAccessToken() {
  if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET) {
    throw new Error('缺少钉钉凭证');
  }
  const res = await axios.post(
    'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    { appKey: DINGTALK_APP_KEY, appSecret: DINGTALK_APP_SECRET }
  );
  const { accessToken } = res.data;
  if (!accessToken) throw new Error('获取 access_token 失败');
  return accessToken;
}

async function fetchIds(processCode, startTime, endTime, accessToken) {
  const allIds = [];
  let nextCursor = 0;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore && pageCount < 50) {
    pageCount++;
    const started = Date.now();
    const res = await axios.post(
      'https://api.dingtalk.com/v1.0/workflow/processes/instanceIds/query',
      { processCode, startTime, endTime, nextToken: nextCursor, maxResults: 20 },
      {
        headers: {
          'x-acs-dingtalk-access-token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );
    const data = res.data;
    if (data.result?.list) allIds.push(...data.result.list);
    nextCursor = data.result?.nextToken;
    hasMore = !!nextCursor;

    const elapsed = Date.now() - started;
    if (elapsed < 100) await new Promise((r) => setTimeout(r, 100 - elapsed));
  }
  return allIds;
}

async function fetchDetail(instanceId, accessToken) {
  const res = await axios.post(
    `https://oapi.dingtalk.com/topapi/processinstance/get?access_token=${accessToken}`,
    { process_instance_id: instanceId }
  );
  const data = res.data;
  if (data.errcode !== 0) return null;

  const inst = data.process_instance;
  const formValues = {};
  (inst.form_component_values || []).forEach((item) => {
    formValues[item.name] = item.value;
  });

  const operationRecords = (inst.operation_records || []).map((rec) => ({
    userId: rec.userid || '',
    type: rec.type || '',
    result: rec.result || '',
    date: rec.date || null,
    remark: rec.remark || '',
  }));

  const pendingApprovers = [];
  (inst.tasks || []).forEach((t) => {
    if (String(t.task_status || '').toUpperCase() === 'RUNNING') {
      pendingApprovers.push({ userId: t.userid || '', userName: '' });
    }
  });

  const fv = formValues || {};
  const rawPaymentUnit =
    fv['付款单位全称'] ||
    fv['付款单位'] ||
    fv['付款公司'] ||
    fv['付款方'] ||
    null;
  const payeeAccount =
    fv['收款账户'] || fv['收款人'] || fv['收款方'] || null;

  const amountKey = [
    '补退金额（元）',
    '借款金额（元）',
    '本次申请支付金额（元）',
    '报销金额',
    '总价款（元）',
    '金额（元）',
  ].find((k) => fv[k] != null && fv[k] !== 'null');

  return {
    processInstanceId: instanceId,
    title: inst.title,
    status: inst.status,
    result: inst.result,
    createTime: inst.create_time,
    finishTime: inst.finish_time,
    paymentUnit: rawPaymentUnit,
    payeeAccount,
    amount: amountKey ? fv[amountKey] : null,
    items: [],
    formValues,
    operationRecords,
    pendingApprovers,
  };
}

/* ============================================================
 * 同步一次
 * ============================================================ */
async function runSyncOnce(trigger = 'auto') {
  if (running) {
    return { ok: false, message: '同步进行中，请稍后' };
  }
  running = true;
  const t0 = Date.now();
  console.log(`[DingTalkSync] 开始同步（触发：${trigger}）`);

  try {
    await markRun('running', `触发方式：${trigger}`);

    const cfg = await getConfig();
    const lookbackDays = Number(cfg.lookback_days) || 30;

    const accessToken = await getAccessToken();

    const TEMPLATE_FILE = path.join(
      __dirname,
      '..',
      'data',
      'dingtalk_templates.json'
    );
    let templates = [];
    try {
      const raw = fs.readFileSync(TEMPLATE_FILE, 'utf-8');
      templates = JSON.parse(raw);
    } catch (e) {
      throw new Error(`读模板缓存失败：${e.message}`);
    }

    const now = Date.now();
    const startTs = now - lookbackDays * 24 * 60 * 60 * 1000;
    const endTs = now;

    let totalIds = 0;
    let totalFetched = 0;
    let totalWritten = 0;
    let totalAutoAssigned = 0;

    for (const tpl of templates) {
      if (!tpl.processCode) continue;

      let ids = [];
      try {
        ids = await fetchIds(tpl.processCode, startTs, endTs, accessToken);
        totalIds += ids.length;
      } catch (e) {
        console.warn(`[DingTalkSync] ${tpl.name} 拉实例失败`, e.message);
        continue;
      }

      const finalIds = await cache.getFinalIds(ids).catch(() => new Set());
      const need = ids.filter((id) => !finalIds.has(id));
      if (need.length === 0) continue;

      const fetched = [];
      for (const id of need) {
        const started = Date.now();
        try {
          const detail = await fetchDetail(id, accessToken);
          if (detail) {
            const r = resolveMemberRefundPaymentUnit(
              tpl.name,
              detail.formValues,
              detail.paymentUnit,
              detail.createTime
            );
            if (r.autoAssigned) totalAutoAssigned++;

            if (tpl.name === MEMBER_REFUND_TEMPLATE) {
              detail.formValues = {
                ...detail.formValues,
                __autoAssigned: r.autoAssigned ? '1' : '0',
                __storeName: r.storeName || '',
                __assignReason: r.reason || '',
              };
            }

            fetched.push({
              templateName: tpl.name,
              processCode: tpl.processCode,
              ...detail,
              paymentUnit: r.paymentUnit,
            });
          }
        } catch (e) {
          console.warn(`[DingTalkSync] 详情失败 ${id}`, e.message);
        }
        const elapsed = Date.now() - started;
        if (elapsed < 100)
          await new Promise((r) => setTimeout(r, 100 - elapsed));
      }
      totalFetched += fetched.length;

      const finals = fetched.filter(
        (d) => String(d.status || '').toUpperCase() === 'COMPLETED'
      );
      if (finals.length > 0) {
        await cache.upsertMany(finals, tpl.name, tpl.processCode);
        totalWritten += finals.length;
      }
    }

    const cost = Date.now() - t0;
    const msg = `扫描 ${totalIds} 个 ID，拉取 ${totalFetched} 条，写入 ${totalWritten} 条（门店自动归属 ${totalAutoAssigned} 条），耗时 ${cost}ms`;
    console.log(`[DingTalkSync] 完成：${msg}`);
    await markRun('success', msg);
    return { ok: true, message: msg };
  } catch (e) {
    console.error('[DingTalkSync] 同步失败', e.message);
    await markRun('failed', e.message);
    return { ok: false, message: e.message };
  } finally {
    running = false;
  }
}

/* ============================================================
 * 动态调度
 * ============================================================ */
function clearTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function msUntilNextRun(cfg) {
  const now = new Date();

  if (cfg.schedule_mode === 'interval') {
    const intervalMs =
      Math.max(1, Number(cfg.interval_hours) || 6) * 60 * 60 * 1000;
    return intervalMs;
  }

  const hour = Math.min(23, Math.max(0, Number(cfg.daily_hour) || 3));
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function scheduleNext() {
  clearTimer();
  try {
    const cfg = await getConfig();
    if (!cfg.enabled) {
      console.log('[DingTalkSync] 已禁用，不调度');
      return;
    }
    const delay = msUntilNextRun(cfg);
    console.log(
      `[DingTalkSync] 下次同步：${new Date(
        Date.now() + delay
      ).toLocaleString()}（模式：${cfg.schedule_mode}）`
    );
    timer = setTimeout(async () => {
      await runSyncOnce('auto');
      scheduleNext();
    }, delay);
  } catch (e) {
    console.error('[DingTalkSync] 调度失败', e.message);
  }
}

async function restartSchedule() {
  await scheduleNext();
}

function startDingTalkSync() {
  /* ⭐ 先清理残留 running 状态，避免面板一直转圈 */
  resetStaleRunningState();

  setTimeout(async () => {
    try {
      const cfg = await getConfig();
      if (cfg.enabled) {
        await runSyncOnce('startup');
      }
    } catch (e) {
      console.warn('[DingTalkSync] 启动同步失败', e.message);
    }
    scheduleNext();
  }, 60 * 1000);
}

module.exports = {
  startDingTalkSync,
  restartSchedule,
  runSyncOnce,
  getConfig,
  updateConfig,
  markRun,
  resetStaleRunningState,
  resolveMemberRefundPaymentUnit,
  extractStoreName,
  mapStoreToCompany,
  isAfterMemberRefundEffective,
  STORE_COMPANY_MAP,
  MEMBER_REFUND_TEMPLATE,
  MEMBER_REFUND_EFFECTIVE_FROM,
};