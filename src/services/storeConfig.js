/* ============================================================
 * ⭐ 门店配置：MySQL 读写 + 匹配工具
 * ============================================================ */
const { pool } = require('../db');

/* ---------- 默认数据（首次访问时兜底） ---------- */
const DEFAULT_STORES = [
  {
    id: '12279',
    name: '富贵园',
    shortName: '富贵园',
    paymentUnits: [
      '北京林朗韵动体育管理有限公司',
      '北京林朗体育管理有限公司东花市大街分公司',
    ],
    keywords: ['富贵园', '富贵', '东花市'],
    isDefault: true,
    sortOrder: 1,
  },
  {
    id: '11536',
    name: '哈德门',
    shortName: '哈德门',
    paymentUnits: [
      '北京林朗悦动体育管理有限公司',
      '北京林朗体育管理有限公司',
    ],
    keywords: ['哈德门', '哈德'],
    isDefault: false,
    sortOrder: 2,
  },
];

/* ---------- 从数据库读取 ---------- */
async function listStores() {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, short_name, payment_units, keywords, is_default, sort_order
         FROM gym_store_config
        ORDER BY sort_order ASC, id ASC`
    );
    if (!rows || rows.length === 0) return DEFAULT_STORES;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      shortName: r.short_name || r.name,
      paymentUnits: safeParseArray(r.payment_units),
      keywords: safeParseArray(r.keywords),
      isDefault: !!r.is_default,
      sortOrder: r.sort_order || 0,
    }));
  } catch (e) {
    console.warn('[storeConfig] 读取失败，使用默认配置：', e.message);
    return DEFAULT_STORES;
  }
}

function safeParseArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ---------- 保存（整体替换） ---------- */
async function saveStores(list) {
  if (!Array.isArray(list)) throw new Error('stores 必须是数组');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    /* 清空并重写（门店数量少，简单粗暴） */
    await conn.query(`DELETE FROM gym_store_config`);

    let i = 1;
    for (const s of list) {
      if (!s?.id || !s?.name) continue;
      await conn.query(
        `INSERT INTO gym_store_config
           (id, name, short_name, payment_units, keywords, is_default, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          String(s.id),
          String(s.name),
          String(s.shortName || s.name),
          JSON.stringify(Array.isArray(s.paymentUnits) ? s.paymentUnits : []),
          JSON.stringify(Array.isArray(s.keywords) ? s.keywords : []),
          s.isDefault ? 1 : 0,
          i++,
        ]
      );
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ---------- 匹配工具 ---------- */
async function matchStoreByPaymentUnit(paymentUnit) {
  const raw = paymentUnit == null ? '' : String(paymentUnit).trim();
  if (!raw) return '';
  const stores = await listStores();

  /* 精确 */
  for (const s of stores) {
    for (const u of s.paymentUnits) {
      if (raw === u) return s.name;
    }
  }
  /* 双向包含 */
  for (const s of stores) {
    for (const u of s.paymentUnits) {
      if (raw.includes(u) || u.includes(raw)) return s.name;
    }
  }
  /* 门店名直接出现在付款单位里 */
  for (const s of stores) {
    if (raw.includes(s.name) || raw.includes(s.shortName)) return s.name;
  }
  return '';
}

async function matchStoreByText(text) {
  const t = text == null ? '' : String(text);
  if (!t) return '';
  const stores = await listStores();

  let bestStore = '';
  let bestIdx = Number.POSITIVE_INFINITY;
  for (const s of stores) {
    for (const k of s.keywords) {
      if (!k) continue;
      const idx = t.indexOf(k);
      if (idx !== -1 && idx < bestIdx) {
        bestIdx = idx;
        bestStore = s.name;
      }
    }
  }
  return bestStore;
}

async function matchStoreByItem(item) {
  const byUnit = await matchStoreByPaymentUnit(item?.paymentUnit);
  if (byUnit) return byUnit;

  const parts = [];
  if (Array.isArray(item?.items)) {
    item.items.forEach((it) => {
      if (it?.content) parts.push(String(it.content));
    });
  }
  const fv = item?.formValues || {};
  [
    '付款内容提要', '借款提要', '事项', '事项/明细', '报销事由',
    '费用类型', '明细', '备注', '用途', '摘要', '事由', '说明',
  ].forEach((k) => {
    const v = fv[k];
    if (v == null || v === 'null' || v === '') return;
    if (typeof v === 'object') {
      try { parts.push(JSON.stringify(v)); } catch {}
    } else {
      parts.push(String(v));
    }
  });
  const rawDetail = fv['明细列表'];
  if (typeof rawDetail === 'string' && rawDetail && rawDetail !== 'null') {
    try {
      const parsed = JSON.parse(rawDetail);
      if (Array.isArray(parsed)) {
        parsed.forEach((row) => {
          (row?.rowValue || []).forEach((f) => {
            if (f?.value != null && f.value !== 'null') {
              parts.push(String(f.value));
            }
          });
        });
      }
    } catch { /* ignore */ }
  }
  if (item?.title) parts.push(String(item.title));

  return matchStoreByText(parts.join(' '));
}

module.exports = {
  listStores,
  saveStores,
  matchStoreByPaymentUnit,
  matchStoreByText,
  matchStoreByItem,
  DEFAULT_STORES,
};