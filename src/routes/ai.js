const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const dingtalkCache = require('../services/dingtalkCache');
const storeConfig = require('../services/storeConfig');
const aiConfig = require('../services/aiConfig');
const {
  classifyDingtalkItems,
  collectDingtalkText,
  MEMBER_REFUND_TPL,
} = require('../services/dingtalkClassify');

const ARK_API_KEY = process.env.ARK_API_KEY;
const ARK_MODEL_ID = process.env.ARK_MODEL_ID;

console.log('[AI] 路由文件已加载', {
  hasKey: !!ARK_API_KEY,
  hasModel: !!ARK_MODEL_ID,
});

if (!ARK_API_KEY || !ARK_MODEL_ID) {
  console.warn(
    '[AI] ⚠️ 缺少配置：ARK_API_KEY / ARK_MODEL_ID，请在 .env 里设置'
  );
}

/* ============================================================
 * 会员退费 → 付款单位推断
 * ============================================================ */
const FU_GUI_YUAN_UNIT = '北京林朗韵动体育管理有限公司';
const HA_DE_MEN_UNIT = '北京林朗悦动体育管理有限公司';
const REFUND_KEYWORDS = ['富贵园', '装修'];

function inferRefundPaymentUnit(item) {
  if (item.templateName !== MEMBER_REFUND_TPL) return null;
  if (item.paymentUnit && String(item.paymentUnit).trim()) return null;
  const combined = collectDingtalkText(item);
  if (!combined) return HA_DE_MEN_UNIT;
  const hit = REFUND_KEYWORDS.some((k) => combined.includes(k));
  return hit ? FU_GUI_YUAN_UNIT : HA_DE_MEN_UNIT;
}

/* ============================================================
 * 金额兜底
 * ============================================================ */
function pickAmountSafe(item) {
  const candidates = [
    '补退金额（元）', '补退金额', '退款金额（元）', '退款金额',
    '报销金额', '借款金额（元）', '借款金额',
    '本次申请支付金额（元）', '本次申请支付金额',
    '总价款（元）', '金额（元）', '金额',
  ];
  const fv = item.formValues || {};
  for (const k of candidates) {
    const v = fv[k];
    if (v != null && v !== 'null' && v !== '') {
      const n = Number(String(v).replace(/[^\d.-]/g, ''));
      if (Number.isFinite(n) && n !== 0) return n;
    }
  }
  const n0 = Number(item.amount);
  if (Number.isFinite(n0) && n0 !== 0) return n0;
  return 0;
}

function monthRangeTs(month) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0, 23, 59, 59);
  return { startTs: first.getTime(), endTs: last.getTime() };
}

/* ============================================================
 * 拉取 + 聚合（门店过滤走 MySQL 配置）
 * ============================================================ */
async function loadDingtalkForAI(storeName, month, storeId) {
  const { startTs, endTs } = monthRangeTs(month);

  const TEMPLATE_FILE = path.join(__dirname, '..', 'data', 'dingtalk_templates.json');
  let templates = [];
  try {
    const raw = fs.readFileSync(TEMPLATE_FILE, 'utf-8');
    templates = JSON.parse(raw);
  } catch (e) {
    console.warn('[AI][dingtalk] 读取模板缓存失败', e.message);
  }
  const EXCLUDE_KEYWORDS = ['银行账户'];
  templates = templates.filter(
    (t) => t.name && !EXCLUDE_KEYWORDS.some((k) => t.name.includes(k))
  );
  const processCodes = templates.map((t) => t.processCode);

  let cached = [];
  try {
    cached = await dingtalkCache.getCachedAll(startTs, endTs, processCodes);
  } catch (e) {
    console.warn('[AI][dingtalk] 查缓存失败', e.message);
  }

  /* 会员退费：优先补 paymentUnit */
  const enriched = cached.map((d) => {
    const inferred = inferRefundPaymentUnit(d);
    const finalUnit =
      inferred && (!d.paymentUnit || !String(d.paymentUnit).trim())
        ? inferred
        : d.paymentUnit;
    return { ...d, paymentUnit: finalUnit };
  });

  /* ⭐ 门店过滤：走 storeConfig.matchStoreByItem（异步） */
  const storeItems = [];
  for (const d of enriched) {
    if (!storeName) {
      storeItems.push(d);
      continue;
    }
    try {
      const matched = await storeConfig.matchStoreByItem(d);
      if (matched === storeName) storeItems.push(d);
    } catch (e) {
      console.warn('[AI][dingtalk] matchStoreByItem 失败', e.message);
    }
  }

  /* 分类聚合 */
  const groups = new Map();
  let total = 0;
  let count = 0;
  const breakdown = {
    salary: { count: 0, total: 0 },
    property: { count: 0, total: 0 },
    electric: { count: 0, total: 0 },
    water: { count: 0, total: 0 },
    repair: { count: 0, total: 0 },
    daily: { count: 0, total: 0 },
    refund: { count: 0, total: 0 },
    other: { count: 0, total: 0 },
  };

  for (const item of storeItems) {
    if (item.error) continue;

    const pieces = classifyDingtalkItems(item, pickAmountSafe);
    for (const p of pieces) {
      if (!groups.has(p.category)) {
        groups.set(p.category, { category: p.category, count: 0, total: 0, samples: [] });
      }
      const g = groups.get(p.category);
      g.count += 1;
      g.total += p.amount;

      if (g.samples.length < 5) {
        const text = collectDingtalkText(item) || item.title || '';
        if (text && text !== '—') g.samples.push(text.slice(0, 60));
      }

      if (p.category === '工资底薪佣金') { breakdown.salary.count += 1; breakdown.salary.total += p.amount; }
      else if (p.category === '物业费') { breakdown.property.count += 1; breakdown.property.total += p.amount; }
      else if (p.category === '电费') { breakdown.electric.count += 1; breakdown.electric.total += p.amount; }
      else if (p.category === '水费') { breakdown.water.count += 1; breakdown.water.total += p.amount; }
      else if (p.category === '修理') { breakdown.repair.count += 1; breakdown.repair.total += p.amount; }
      else if (p.category === '日常支出') { breakdown.daily.count += 1; breakdown.daily.total += p.amount; }
      else if (p.category === '退费') { breakdown.refund.count += 1; breakdown.refund.total += p.amount; }
      else { breakdown.other.count += 1; breakdown.other.total += p.amount; }

      total += p.amount;
      count += 1;
    }
  }

  const categories = Array.from(groups.values())
    .sort((a, b) => b.total - a.total)
    .map((g) => ({ category: g.category, count: g.count, total: g.total, samples: g.samples }));

  const extraExpense =
    breakdown.repair.total + breakdown.daily.total +
    breakdown.refund.total + breakdown.other.total;

  const storeProfile = await aiConfig.getProfile(storeId || storeName, storeName);

  return {
    store: storeName,
    month,
    storeProfile,
    totalCount: count,
    totalAmount: total,
    categories,
    breakdown: { ...breakdown, total, extraExpense },
  };
}

/* ============================================================
 * 路由：AI 月报
 * ============================================================ */
router.post('/ai/monthly-report', async (req, res) => {
  console.log('[AI] 命中 /ai/monthly-report，body keys =', Object.keys(req.body || {}));
  try {
    if (!ARK_API_KEY || !ARK_MODEL_ID) {
      return res.status(500).json({
        errorcode: 500,
        errormsg: '服务端未配置 ARK_API_KEY / ARK_MODEL_ID',
      });
    }

    const payload = req.body || {};

    if (!payload.storeId || !payload.month) {
      return res.status(400).json({
        errorcode: 400,
        errormsg: '缺少 storeId / month',
      });
    }

    const storeName = payload.storeName || String(payload.storeId || '');
    const dingtalk = await loadDingtalkForAI(storeName, payload.month, payload.storeId);

    console.log(
      `[AI] 生成月报：store=${storeName} month=${payload.month} ` +
        `钉钉 ${dingtalk.totalCount} 项 / ${dingtalk.categories.length} 类`
    );

    const mergedPayload = {
      ...payload,
      dingtalkExpenses: dingtalk,
    };

    const r = await axios.post(
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      {
        model: ARK_MODEL_ID,
        messages: [
          { role: 'system', content: await aiConfig.getPrompt() },
          {
            role: 'user',
            content:
              '请基于以下月报数据生成分析报告：\n' +
              JSON.stringify(mergedPayload, null, 2),
          },
        ],
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${ARK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 180000,
      }
    );

    const analysis = r.data?.choices?.[0]?.message?.content || '';

    if (!analysis) {
      console.warn('[AI] 豆包返回空内容：', JSON.stringify(r.data).slice(0, 500));
      return res.status(500).json({
        errorcode: 500,
        errormsg: '豆包返回空内容',
      });
    }

    res.json({ errorcode: 0, data: { analysis } });
  } catch (e) {
    const upstream =
      e?.response?.data?.error?.message ||
      e?.response?.data?.message ||
      e.message;
    console.error('[AI] 调用失败:', upstream);
    res.status(500).json({
      errorcode: 500,
      errormsg: upstream || 'AI 调用失败',
    });
  }
});

/* ============================================================
 * 路由：门店配置（MySQL）
 *   - 前端 StoreConfigPage 调用
 *   - 与 /api/dingtalk/store-config 共享同一张表
 * ============================================================ */
router.get('/ai/store-config', async (req, res) => {
  try {
    const stores = await storeConfig.listStores();
    res.json({ errorcode: 0, errormsg: '获取成功', data: { stores } });
  } catch (e) {
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

router.post('/ai/store-config', async (req, res) => {
  try {
    const list = req.body?.stores;
    if (!Array.isArray(list)) {
      return res.status(400).json({ errorcode: 400, errormsg: '缺少 stores 数组' });
    }
    await storeConfig.saveStores(list);
    const stores = await storeConfig.listStores();
    res.json({ errorcode: 0, errormsg: '保存成功', data: { stores } });
  } catch (e) {
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 健康检查
 * ============================================================ */
router.get('/ai/__ping', (req, res) => {
  res.json({ ok: true, msg: 'ai routes mounted' });
});

// 额外的 AI 配置 API，与本文件共享同一个挂载前缀。
router.use((req, res, next) => {
  if (req.path.startsWith('/ai/config')) {
    console.log('[AI Config][route]', req.method, req.originalUrl, {
      hasAuthorization: !!req.headers.authorization,
      hasBearer: /^Bearer\s+\S+/i.test(req.headers.authorization || ''),
    });
  }
  next();
});
router.use(require('./aiConfigRoutes'));

module.exports = router;