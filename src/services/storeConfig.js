/* ============================================================
 * ⭐ 门店配置：MySQL 读写 + 匹配工具
 *   - 门店名归一化：去掉结尾的「店」
 *   - paymentUnits：支持「公司 + 有效时间段」
 *   - 付款公司 → 门店（按 paymentUnits 顺序匹配）
 *   - 门店 + 发起时间 → 该门店下有效公司
 * ============================================================ */
const { pool } = require('../db');

/* ⭐ 门店名归一化：富贵园店 → 富贵园 */
function normalizeStoreName(name) {
  const raw = name == null ? '' : String(name).trim();
  if (!raw) return '';
  return raw.replace(/店$/, '').trim();
}

/* ⭐ 解析 paymentUnits：兼容 string[] 和对象数组 */
function parsePaymentUnits(raw) {
  if (raw == null) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      if (typeof item === 'string') {
        return { company: item, validFrom: null, validTo: null };
      }
      if (item && typeof item === 'object') {
        return {
          company: String(item.company || item.name || '').trim(),
          validFrom: item.validFrom ? String(item.validFrom) : null,
          validTo: item.validTo ? String(item.validTo) : null,
        };
      }
      return null;
    })
    .filter((x) => x && x.company);
}

function stringifyPaymentUnits(list) {
  return JSON.stringify(parsePaymentUnits(list));
}

/* ⭐ 日期归一：YYYY-MM-DD */
function toDateStr(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const s = String(v).trim().replace(/\//g, '-');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/* ⭐ 判断某公司在某日期是否有效 */
function isCompanyValidAt(entry, atDate) {
  if (!atDate) return true;
  if (!entry.validFrom && !entry.validTo) return true;
  const from = toDateStr(entry.validFrom);
  const to = toDateStr(entry.validTo);
  const at = toDateStr(atDate);
  if (!at) return true;
  if (from && at < from) return false;
  if (to && at > to) return false;
  return true;
}

/* ---------- 默认数据 ---------- */
const DEFAULT_STORES = [
  {
    id: '12279',
    name: '富贵园',
    shortName: '富贵园',
    paymentUnits: [
      { company: '北京林朗韵动体育管理有限公司' },
      { company: '北京林朗体育管理有限公司东花市大街分公司' },
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
      { company: '北京林朗悦动体育管理有限公司' },
      { company: '北京林朗体育管理有限公司' },
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
    return rows.map((r) => {
      const cleanName = normalizeStoreName(r.name) || r.name;
      const cleanShort =
        normalizeStoreName(r.short_name || r.name) || r.short_name || cleanName;
      return {
        id: r.id,
        name: cleanName,
        shortName: cleanShort,
        paymentUnits: parsePaymentUnits(r.payment_units),
        keywords: safeParseArray(r.keywords),
        isDefault: !!r.is_default,
        sortOrder: r.sort_order || 0,
      };
    });
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

/* ---------- 保存 ---------- */
async function saveStores(list) {
  if (!Array.isArray(list)) throw new Error('stores 必须是数组');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM gym_store_config`);

    let i = 1;
    for (const s of list) {
      if (!s?.id || !s?.name) continue;
      const cleanName = normalizeStoreName(s.name) || String(s.name);
      const cleanShort =
        normalizeStoreName(s.shortName || s.name) || cleanName;

      await conn.query(
        `INSERT INTO gym_store_config
           (id, name, short_name, payment_units, keywords, is_default, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          String(s.id),
          cleanName,
          cleanShort,
          stringifyPaymentUnits(s.paymentUnits || []),
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

/* ============================================================
 * ⭐ 付款公司名称 → 门店
 *   1) 精确匹配
 *   2) 双向包含
 *   3) 门店名出现在付款公司名称里
 * ============================================================ */
async function resolveStoreByPaymentUnit(paymentUnit) {
  const raw = paymentUnit == null ? '' : String(paymentUnit).trim();
  if (!raw) return '';
  const stores = await listStores();

  for (const s of stores) {
    for (const u of s.paymentUnits) {
      if (raw === u.company) {
        return normalizeStoreName(s.name) || s.name;
      }
    }
  }
  for (const s of stores) {
    for (const u of s.paymentUnits) {
      if (raw.includes(u.company) || u.company.includes(raw)) {
        return normalizeStoreName(s.name) || s.name;
      }
    }
  }
  for (const s of stores) {
    const name = normalizeStoreName(s.name) || s.name;
    const short = normalizeStoreName(s.shortName || s.name) || s.shortName;
    if (raw.includes(name) || (short && raw.includes(short))) return name;
  }
  return '';
}

/* ============================================================
 * ⭐ 门店 + 发起时间 → 该门店下有效公司
 *   按 paymentUnits 顺序，选第一家「有效时间段包含 atDate」的公司
 * ============================================================ */
async function resolveCompanyInStore(storeName, atDate) {
  const clean = normalizeStoreName(storeName) || storeName;
  if (!clean) return null;
  const stores = await listStores();
  const store = stores.find(
    (s) => (normalizeStoreName(s.name) || s.name) === clean
  );
  if (!store) return null;

  for (const entry of store.paymentUnits) {
    if (isCompanyValidAt(entry, atDate)) {
      return {
        storeName: clean,
        company: entry.company,
        validFrom: entry.validFrom || null,
        validTo: entry.validTo || null,
      };
    }
  }
  /* 都不在有效期，返回第一家（保底） */
  if (store.paymentUnits.length > 0) {
    const first = store.paymentUnits[0];
    return {
      storeName: clean,
      company: first.company,
      validFrom: first.validFrom || null,
      validTo: first.validTo || null,
      fallback: true,
    };
  }
  return null;
}

/* ---------- 文本 → 门店 ---------- */
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
        bestStore = normalizeStoreName(s.name) || s.name;
      }
    }
  }
  return bestStore;
}

/* ---------- 一条记录 → 门店 ---------- */
async function matchStoreByItem(item) {
  const byUnit = await resolveStoreByPaymentUnit(item?.paymentUnit);
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

async function matchStoreByPaymentUnit(paymentUnit) {
  return resolveStoreByPaymentUnit(paymentUnit);
}

module.exports = {
  listStores,
  saveStores,
  normalizeStoreName,
  parsePaymentUnits,
  stringifyPaymentUnits,
  resolveStoreByPaymentUnit,
  resolveCompanyInStore,   /* ⭐ 门店 + 日期 → 公司 */
  matchStoreByPaymentUnit,
  matchStoreByText,
  matchStoreByItem,
  DEFAULT_STORES,
};