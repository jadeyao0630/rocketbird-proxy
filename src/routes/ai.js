const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const dingtalkCache = require('../services/dingtalkCache');
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
 * 门店硬件 / 业态画像
 * ============================================================ */
const STORE_PROFILES = {
  '富贵园': {
    name: '富贵园店',
    area: '3000 多平米',
    facilities: ['泳池', '操房', '乒乓球', '篮球场', '私教区', '搏击区', '有氧区', '器械区'],
    positioning:
      '综合型旗舰店，设施齐全、面积大、可承载泳教 / 篮球 / 搏击 / 操课等多业态；固定成本（水电、物业、租金、保洁）体量明显高于哈德门。',
    focus: [
      '泳池、篮球场、操房等高能耗 / 高维护区域是电费、水费、保洁费、维修费的主要来源，需要单独关注其坪效。',
      '多业态意味着收入结构更分散，需关注各业态（售卡 vs 售课 vs 泳教）的毛利差异。',
      '大面积场地固定成本刚性高，盈亏平衡点更依赖收入规模，需重点看坪效与人效。',
    ],
  },
  '哈德门': {
    name: '哈德门店',
    area: '600 多平米',
    facilities: ['私教区', '有氧区', '器械区', '操房', '乒乓球'],
    positioning:
      '小而精社区型门店，以私教、有氧、器械、操房为主；固定成本相对低，坪效 / 人效是关键指标。',
    focus: [
      '面积小、私教占比高，需关注私教课提与私教销售的贡献度。',
      '无泳池 / 篮球场，水电与保洁负担轻，固定成本压力小，利润率更容易做正。',
      '场地有限，器械 / 操房高峰期冲突概率高，需关注排课与会员体验。',
    ],
  },
};

function getStoreProfile(storeName) {
  if (!storeName) return null;
  if (STORE_PROFILES[storeName]) return STORE_PROFILES[storeName];
  const hit = Object.keys(STORE_PROFILES).find(
    (k) => storeName.includes(k) || k.includes(storeName)
  );
  return hit ? STORE_PROFILES[hit] : null;
}

/* ============================================================
 * 会员退费 / 门店过滤
 * ============================================================ */
const FU_GUI_YUAN_UNIT = '北京林朗韵动体育管理有限公司';
const HA_DE_MEN_UNIT = '北京林朗悦动体育管理有限公司';
const REFUND_KEYWORDS = ['富贵园', '装修'];

const STORE_UNIT_MAP = {
  '哈德门': ['北京林朗悦动体育管理有限公司', '北京林朗体育管理有限公司'],
  '富贵园': ['北京林朗韵动体育管理有限公司', '北京林朗体育管理有限公司东花市大街分公司'],
};

function paymentUnitMatchesStore(paymentUnit, storeName) {
  if (!storeName) return true;
  const units = STORE_UNIT_MAP[storeName];
  if (!units) return true;
  const pu = String(paymentUnit || '');
  return units.some((u) => pu.includes(u) || u.includes(pu));
}

const PAYMENT_UNIT_TO_STORE = {
  '北京林朗悦动体育管理有限公司': '哈德门',
  '北京林朗体育管理有限公司': '哈德门',
  '北京林朗韵动体育管理有限公司': '富贵园',
  '北京林朗体育管理有限公司东花市大街分公司': '富贵园',
};

function getStoreFromPaymentUnit(paymentUnit) {
  if (!paymentUnit) return '';
  const pu = String(paymentUnit);
  if (PAYMENT_UNIT_TO_STORE[pu]) return PAYMENT_UNIT_TO_STORE[pu];
  for (const [unit, store] of Object.entries(PAYMENT_UNIT_TO_STORE)) {
    if (pu.includes(unit) || unit.includes(pu)) return store;
  }
  if (pu.includes('东花市')) return '富贵园';
  return '';
}

function inferRefundPaymentUnit(item) {
  if (item.templateName !== MEMBER_REFUND_TPL) return null;
  if (item.paymentUnit && String(item.paymentUnit).trim()) return null;
  const combined = collectDingtalkText(item);
  if (!combined) return HA_DE_MEN_UNIT;
  const hit = REFUND_KEYWORDS.some((k) => combined.includes(k));
  return hit ? FU_GUI_YUAN_UNIT : HA_DE_MEN_UNIT;
}

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
 * 拉取 + 聚合（复用公共 classify）
 * ============================================================ */
async function loadDingtalkForAI(storeName, month) {
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

  const enriched = cached.map((d) => {
    const inferred = inferRefundPaymentUnit(d);
    const finalUnit =
      inferred && (!d.paymentUnit || !String(d.paymentUnit).trim())
        ? inferred
        : d.paymentUnit;
    return { ...d, paymentUnit: finalUnit };
  });

  const storeItems = enriched.filter((d) => {
    if (!storeName) return true;
    if (paymentUnitMatchesStore(d.paymentUnit, storeName)) {
      const pu = String(d.paymentUnit || '').trim();
      if (pu) return true;
      if (d.templateName === MEMBER_REFUND_TPL) {
        const finalStore = getStoreFromPaymentUnit(d.paymentUnit);
        return finalStore === storeName;
      }
      return false;
    }
    return false;
  });

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

  const storeProfile = getStoreProfile(storeName);

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
 * SYSTEM PROMPT
 * ============================================================ */
const SYSTEM_PROMPT = `
你是健身房运营分析师。数据已经在前端以图表、卡片形式展示，你的任务是**只做文字分析与决策建议**，不要重复罗列数据明细。

**分析师背景要求**：
- 你熟悉连锁健身房的经营模型：收入结构（售卡 / 售课 / 续费 / 私教）、成本结构（薪酬 / 固定成本 / 日常运营）、坪效与人效。
- 你能根据**门店硬件与业态差异**给出针对性建议，而不是套话。
- 你会把「钉钉流程中的非薪酬支出」与「门店硬件特征」结合起来解释原因。
- 输出要像一个有 5 年以上健身房运营经验的人给出的判断，有取舍、有优先级、有可执行动作。

【成本口径说明 — 必须遵守】

1. **预估总支出** = 薪酬（payroll）+ 固定成本（fixedCost）
2. **钉钉实际支出（新增）** = 退费 + 修理 + 日常支出 + 其它
   - 不含工资底薪佣金、物业费、电费、水费，因为这四项已包含在 payroll / fixedCost 里，避免重复
   - 钉钉的工资底薪佣金 / 物业费 / 电费 / 水费 只作为「预估 vs 实际」的对比展示，不重复计入
3. **实际总支出** = 预估总支出 + 钉钉实际支出（新增）
4. 「钉钉事项明细分析」段落**必须列出「预估 vs 钉钉实际」对比**，格式：
   - **工资底薪佣金**：预估 ¥X（payroll），钉钉实际 ¥Y（N 项）
   - **物业费**：预估 ¥X（fixedCost.propertyFee），钉钉实际 ¥Y（N 项）
   - **电费**：预估 ¥X（fixedCost.electricityFee），钉钉实际 ¥Y（N 项）
   - **水费**：预估 ¥X（fixedCost.waterFee），钉钉实际 ¥Y（N 项）
   - **钉钉新增支出**：退费 / 修理 / 日常支出 / 其它，¥Z（N 项）
5. 若「钉钉实际」明显大于或小于「预估」，必须点出，并提示用户核查是否存在跨期、重复列支、漏记等问题。

输出结构（严格按此，总长度控制在 900 字以内）：

## 一句话结论
（1 句话，说明本月盈利/亏损、核心问题、最重要的行动方向）

## 核心指标速览
（只列 8~12 个最关键指标，无序列表，不要展开）
- 总收入：xxx 元
- 预估总支出：xxx 元
- 钉钉实际支出（新增）：xxx 元
- 实际总支出：xxx 元
- 预估利润：xxx 元
- 实际利润：xxx 元（利润率 x.x%）
- 薪酬占收入：x.x%
- 售卡 Top1 卡种：xxx（占 xx.x%）
- 售课 Top1 课种：xxx（占 xx.x%）

## 钉钉事项明细分析
（**这一段必须写**，围绕下列类别逐项分析，每条 1~2 句：金额、笔数、占比、是否异常、值得关注的点）
类别：
- 工资底薪佣金（**必须列预估 vs 钉钉实际对比**）
- 物业费（**必须列预估 vs 钉钉实际对比**）
- 电费（**必须列预估 vs 钉钉实际对比**）
- 水费（**必须列预估 vs 钉钉实际对比**）
- 修理
- 日常支出
- 退费
- 其它

分析要求：
1. 按金额从大到小列出；
2. 每类给出金额、笔数、占钉钉总额的百分比；
3. **结合门店硬件解释合理性**：
   - 富贵园店：3000+ 平、含泳池/篮球场/操房/搏击区/乒乓球/私教/有氧/器械。电费、水费、保洁费、物业费、修理费偏高**属于正常**，但要判断「偏高是否与面积匹配」「单平米成本是否高于行业均值」。
   - 哈德门店：600+ 平、含私教/有氧/器械/操房/乒乓球。若电费、水费、修理费偏高则**相对异常**，需排查设备老化、跑冒滴漏或排课冲突。
4. **退费**类：给出笔数与金额；若金额为 0 但有笔数，明确提示「金额未体现在明细中，建议核对表单」。

## 3 个最值得关注的问题
（只写 3 条，每条 2 句话：现象 + 影响或建议，有序列表。要结合门店硬件差异，不要泛泛而谈）

## 2 条行动建议
（只写 2 条，具体、可执行、带方向，有序列表。要结合门店硬件差异）

约束：
- 使用标准 Markdown 语法（##、-、1.、**粗体**）
- 不要输出表格（| ... |）
- 不要重复罗列前端已展示的售卡/售课/个人排行
- 金额保留整数，百分比保留 1 位小数
- 只基于提供的数据，不编造
- 总长度不超过 900 字

【门店画像参考】
数据里的 storeProfile 字段包含门店面积、硬件/业态清单、定位与关注点。请在分析中主动引用这些特征来解释数据。
`.trim();

/* ============================================================
 * 路由
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
    const dingtalk = await loadDingtalkForAI(storeName, payload.month);

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
          { role: 'system', content: SYSTEM_PROMPT },
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

router.get('/ai/__ping', (req, res) => {
  res.json({ ok: true, msg: 'ai routes mounted' });
});

module.exports = router;