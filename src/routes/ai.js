const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

/* ⭐ 只依赖缓存服务，不引入 dingtalkSync */
const dingtalkCache = require('../services/dingtalkCache');

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
 * ⭐ 会员退费门店归属（与 dingtalkSync 一致的规则，内置一份）
 * ============================================================ */
const STORE_COMPANY_MAP = {
  '富贵园店': '北京林朗韵动体育管理有限公司',
  '哈德门店': '北京林朗悦动体育管理有限公司',
};

const MEMBER_REFUND_TEMPLATE = '会员退费';
const MEMBER_REFUND_EFFECTIVE_FROM = '2026-10-01';
const STORE_FIELD_KEYS = ['门店', '所属门店', '门店名称', '校区'];

function parseBeijingDate(s) {
  if (!s) return null;
  const str = String(s).trim().replace(/\//g, '-');
  const d = new Date(str.replace(' ', 'T') + '+08:00');
  return isNaN(d.getTime()) ? null : d;
}

function isAfterMemberRefundEffective(createTime) {
  const d = parseBeijingDate(createTime);
  if (!d) return false;
  const start = parseBeijingDate(MEMBER_REFUND_EFFECTIVE_FROM + ' 00:00:00');
  if (!start) return false;
  return d.getTime() >= start.getTime();
}

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
 * ⭐ 会员退费：按门店字段重算 paymentUnit（纯计算，不触发任何同步）
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
 * 门店 → 付款单位
 * ============================================================ */
const STORE_UNIT_MAP = {
  '哈德门': [
    '北京林朗悦动体育管理有限公司',
    '北京林朗体育管理有限公司',
  ],
  '富贵园': [
    '北京林朗韵动体育管理有限公司',
    '北京林朗体育管理有限公司东花市大街分公司',
  ],
};

function paymentUnitMatchesStore(paymentUnit, storeName) {
  if (!storeName) return true;
  const units = STORE_UNIT_MAP[storeName];
  if (!units) return true;
  const pu = String(paymentUnit || '');
  return units.some((u) => pu.includes(u) || u.includes(pu));
}

/* ============================================================
 * 月份 → 时间范围
 * ============================================================ */
function monthRangeTs(month) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0, 23, 59, 59);
  return { startTs: first.getTime(), endTs: last.getTime() };
}

/* ============================================================
 * 事项分类规则
 *   顺序：退费 → 工资底薪佣金 → 物业费 → 水电费 → 修理 → 日常支出
 * ============================================================ */
const SUBJECT_RULES = [
  /* 工资底薪佣金（含收款账户命中） */
  {
    key: '工资底薪佣金',
    keywords: [
      '工资', '底薪', '佣金', '提成', '薪酬', '薪金',
      '劳务', '派遣', '人力资源',
    ],
    payees: ['山东云优人力资源服务有限公司'],
  },
  /* 物业费 */
  {
    key: '物业费',
    keywords: ['物业费', '物业'],
  },
  /* 水电费 */
  {
    key: '水电费',
    keywords: ['电费', '水费', '水电'],
  },
  /* 修理 */
  {
    key: '修理',
    keywords: [
      '修理', '维修', '修缮', '保养', '配件更换',
      '更换', '安装', '装修',
    ],
  },
  /* 日常支出 */
  {
    key: '日常支出',
    keywords: [
      '办公', '办公用品', '日用', '清洁', '保洁', '耗材',
      '快递', '邮寄', '差旅', '交通', '通讯', '话费',
      '劳保', '低值易耗', '消耗', '采购', '购买',
      '宣传', '广告', '推广', '营销', '物料', '印刷',
    ],
  },
];

/* ============================================================
 * 文本聚合
 * ============================================================ */
function collectItemText(item) {
  const parts = [];

  if (Array.isArray(item.items)) {
    item.items.forEach((it) => {
      if (it?.content) parts.push(String(it.content));
    });
  }

  const fv = item.formValues || {};
  const rawDetail = fv['明细列表'];
  if (typeof rawDetail === 'string' && rawDetail && rawDetail !== 'null') {
    try {
      const parsed = JSON.parse(rawDetail);
      if (Array.isArray(parsed)) {
        parsed.forEach((row) => {
          (row?.rowValue || []).forEach((f) => {
            const label = String(f?.label || '');
            if (
              label.includes('事项') ||
              label.includes('内容') ||
              label.includes('名称')
            ) {
              if (f?.value != null && f.value !== 'null') {
                parts.push(String(f.value));
              }
            }
          });
        });
      }
    } catch {
      /* ignore */
    }
  }

  if (item.title) parts.push(String(item.title));

  [
    '事项', '事项/明细', '报销事由', '费用类型', '明细',
    '备注', '事由', '用途', '摘要', '说明',
    '付款内容提要', '付款事由', '付款用途',
    '借款提要', '退卡原因',
  ].forEach((k) => {
    const v = fv[k];
    if (v == null || v === 'null' || v === '') return;
    if (typeof v === 'object') {
      try { parts.push(JSON.stringify(v)); } catch {}
    } else {
      parts.push(String(v));
    }
  });

  return parts.join(' ');
}

/* ============================================================
 * ⭐ 分类一条钉钉记录
 *   退费优先：templateName === '会员退费' 直接归入「退费」
 * ============================================================ */
function classifyDingtalkItem(item) {
  /* ⭐ 1) 会员退费（按模板名，与钉钉页面一致） */
  if (item.templateName === MEMBER_REFUND_TEMPLATE) {
    return '退费';
  }

  const text = collectItemText(item);
  const payee = String(item.payeeAccount || '');

  /* 2) 收款账户命中（工资底薪佣金） */
  for (const rule of SUBJECT_RULES) {
    if (rule.payees && rule.payees.length > 0) {
      if (rule.payees.some((p) => payee === p || payee.includes(p))) {
        return rule.key;
      }
    }
  }

  /* 3) 关键字 */
  if (text) {
    for (const rule of SUBJECT_RULES) {
      if (rule.keywords.some((k) => k && text.includes(k))) {
        return rule.key;
      }
    }
  }

  return '其它';
}

/* ============================================================
 * 拉取 + 聚合钉钉数据（只读缓存，不触发同步）
 * ============================================================ */
async function loadDingtalkForAI(storeName, month) {
  const { startTs, endTs } = monthRangeTs(month);

  const TEMPLATE_FILE = path.join(
    __dirname, '..', 'data', 'dingtalk_templates.json'
  );
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

  /* 会员退费门店归属（纯计算） */
  const enriched = cached.map((d) => {
    const r = resolveMemberRefundPaymentUnit(
      d.templateName,
      d.formValues || {},
      d.paymentUnit,
      d.createTime
    );
    return {
      ...d,
      paymentUnit: r.paymentUnit,
      _autoAssigned: r.autoAssigned,
      _storeName: r.storeName,
    };
  });

  /* 按门店过滤 */
  const storeItems = enriched.filter((d) =>
    paymentUnitMatchesStore(d.paymentUnit, storeName)
  );

  /* 按事项分类聚合 */
  const groups = new Map();
  for (const item of storeItems) {
    if (item.error) continue;
    const category = classifyDingtalkItem(item);
    const amount = Number(item.amount || 0) || 0;

    if (!groups.has(category)) {
      groups.set(category, {
        category,
        count: 0,
        total: 0,
        samples: [],
      });
    }
    const g = groups.get(category);
    g.count += 1;
    g.total += amount;

    if (g.samples.length < 5) {
      const text = collectItemText(item) || item.title || '';
      if (text && text !== '—') g.samples.push(text.slice(0, 60));
    }
  }

  const categories = Array.from(groups.values())
    .sort((a, b) => b.total - a.total)
    .map((g) => ({
      category: g.category,
      count: g.count,
      total: g.total,
      samples: g.samples,
    }));

  const total = storeItems.reduce(
    (s, it) => s + (Number(it.amount || 0) || 0),
    0
  );

  return {
    store: storeName,
    month,
    totalCount: storeItems.length,
    totalAmount: total,
    categories,
  };
}

/* ============================================================
 * SYSTEM PROMPT
 * ============================================================ */
const SYSTEM_PROMPT = `
你是健身房运营分析师。数据已经在前端以图表、卡片形式展示，你的任务是**只做文字分析与决策建议**，不要重复罗列数据明细。

输出结构（严格按此，总长度控制在 800 字以内）：

## 一句话结论
（1 句话，说明本月盈利/亏损、核心问题、最重要的行动方向）

## 核心指标速览
（只列 8~12 个最关键指标，无序列表，不要展开）
- 总收入：xxx 元
- 总支出：xxx 元
- 利润：xxx 元（利润率 x.x%）
- 薪酬占收入：x.x%
- 售卡 Top1 卡种：xxx（占 xx.x%）
- 售课 Top1 课种：xxx（占 xx.x%）
- 钉钉流程总额：xxx 元（共 xx 笔）

## 钉钉事项明细分析
（**这一段必须写**，围绕下列类别逐项分析，每条 1~2 句：金额、笔数、占比、是否异常、值得关注的点）
类别：
- 工资底薪佣金
- 物业费
- 水电费
- 退费
- 修理
- 日常支出
- 其它

分析要求：
1. 按金额从大到小列出；
2. 每类给出金额、笔数、占钉钉总额的百分比；
3. 若某项金额异常大（占钉钉总额 > 30%）或笔数异常多（> 10 笔），必须点出并提示核查；
4. 「退费」类需与月报收入侧结合，判断退费率是否偏高；
5. 「工资底薪佣金」类需与 payroll 对比，提示是否重复计算。

## 3 个最值得关注的问题
（只写 3 条，每条 2 句话：现象 + 影响或建议，有序列表）

## 2 条行动建议
（只写 2 条，具体、可执行、带方向，有序列表）

约束：
- 使用标准 Markdown 语法（##、-、1.、**粗体**）
- 不要输出表格（| ... |）
- 不要重复罗列前端已展示的售卡/售课/个人排行
- 金额保留整数，百分比保留 1 位小数
- 只基于提供的数据，不编造
- 总长度不超过 800 字
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

    /* ⭐ 从数据库缓存拉钉钉数据（不触发同步） */
    const dingtalk = await loadDingtalkForAI(
      payload.storeName || payload.storeId,
      payload.month
    );

    console.log(
      `[AI] 生成月报：store=${payload.storeName} month=${payload.month} ` +
        `钉钉 ${dingtalk.totalCount} 笔 / ${dingtalk.categories.length} 类`
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