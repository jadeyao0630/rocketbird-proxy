const express = require('express');
const axios = require('axios');
const router = express.Router();

const DINGTALK_APP_KEY = process.env.DINGTALK_APP_KEY;
const DINGTALK_APP_SECRET = process.env.DINGTALK_APP_SECRET;
const SELF_BASE = `http://127.0.0.1:${process.env.PORT || 4000}`;

/* ============================================================
 * GET /api/monthly/dingtalk-expenses?storeId=xxx&month=2026-10
 * 从钉钉拉取"涉及支付"的审批，按门店过滤，汇总支出
 * 复用现有 dingtalk.js 的 /api/dingtalk/report 逻辑
 * ============================================================ */
router.get('/monthly/dingtalk-expenses', async (req, res) => {
  try {
    const storeId = String(req.query.storeId || '').trim();
    const month = String(req.query.month || '').trim();

    if (!storeId || !month) {
      return res.status(400).json({
        errorcode: 400,
        errormsg: '缺少 storeId / month',
      });
    }

    /* 计算当月首尾日 */
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const start = `${month}-01`;
    const end = `${month}-${String(lastDay).padStart(2, '0')}`;

    /* 只查"涉及支付"的流程类型，避免拉一堆无关审批 */
    const PAYMENT_KEYWORDS = [
      '付款申请单',
      '员工费用报销',
      '差旅报销申请',
      '员工借款（备用金）',
      '采购单',
      '底薪、佣金支付申请',
      '会员退费',
    ].join(',');

    console.log(
      `[MonthlySummary] 拉钉钉支出：store=${storeId} month=${month} 类型=${PAYMENT_KEYWORDS}`
    );

    /* 复用现有 dingtalk report 接口（HTTP 自调用） */
    const url = `${SELF_BASE}/api/dingtalk/report`;
    const r = await axios.get(url, {
      params: {
        start,
        end,
        type: PAYMENT_KEYWORDS,
        onlyApproved: 1,
      },
      timeout: 120000,
    });

    const results = r.data?.data?.results || [];

    /* 按门店过滤：paymentUnit 里含 storeId 关键字 */
    const STORE_MATCHERS = {
      富贵园: ['林朗韵动', '富贵园'],
      哈德门: ['林朗悦动', '哈德门'],
    };
    const matchers = STORE_MATCHERS[storeId] || [storeId];

    const filtered = results.filter((it) => {
      const unit = String(it.paymentUnit || '');
      return matchers.some((kw) => unit.includes(kw));
    });

    /* 汇总 */
    const items = filtered.map((it) => ({
      title: it.title || '',
      templateName: it.templateName || '',
      amount: Number(it.amount || 0),
      payee: it.payeeAccount || '',
      paymentUnit: it.paymentUnit || '',
      finishTime: it.finishTime || '',
      category: it.templateName || '其他',
    }));

    const total = items.reduce((s, it) => s + it.amount, 0);

    console.log(
      `[MonthlySummary] 钉钉支出：${filtered.length} 条，合计 ¥${total}`
    );

    res.json({
      errorcode: 0,
      data: { storeId, month, total, count: items.length, items },
    });
  } catch (e) {
    const upstream =
      e?.response?.data?.errormsg ||
      e?.response?.data?.error ||
      e.message;
    console.error('[MonthlySummary] 拉钉钉支出失败:', upstream);
    res.status(500).json({
      errorcode: 500,
      errormsg: upstream || '拉钉钉支出失败',
    });
  }
});

/* ============================================================
 * 路由 6：月综合报告（按月份 + 门店读缓存）
 *   GET /api/dingtalk/monthly-summary?month=2026-10&store=富贵园
 * ============================================================ */
router.get('/dingtalk/monthly-summary', async (req, res) => {
  const t0 = Date.now();
  try {
    const { month, store } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: '缺少或非法 month（YYYY-MM）' });
    }

    const [y, m] = month.split('-').map(Number);
    const firstDay = `${month}-01`;
    const lastDayNum = new Date(y, m, 0).getDate();
    const lastDay = `${month}-${String(lastDayNum).padStart(2, '0')}`;

    const startTs = parseDateTime(firstDay, false);
    const endTs = parseDateTime(lastDay, true);

    let templates = readTemplateCache();
    const EXCLUDE_KEYWORDS = ['银行账户'];
    templates = templates.filter(
      (t) => t.name && !EXCLUDE_KEYWORDS.some((k) => t.name.includes(k))
    );

    const processCodes = templates.map((t) => t.processCode);

    let cached = [];
    try {
      cached = await cache.getCachedAll(startTs, endTs, processCodes);
    } catch (e) {
      console.error('[DingTalk][monthly] 查缓存失败', e.message);
    }

    /* 会员退费门店归属 */
    const enriched = cached.map((d) => {
      const r = dingtalkSync.resolveMemberRefundPaymentUnit(
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
        _assignReason: r.reason,
      };
    });

    /* ⭐ 按门店过滤 */
    const STORE_NAME = store ? String(store).trim() : '';
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

    let filtered = enriched;
    if (STORE_NAME && STORE_UNIT_MAP[STORE_NAME]) {
      const units = STORE_UNIT_MAP[STORE_NAME];
      filtered = enriched.filter((d) => {
        const pu = String(d.paymentUnit || '');
        return units.some((u) => pu.includes(u) || u.includes(pu));
      });
      console.log(
        `[DingTalk][monthly] 门店过滤「${STORE_NAME}」：${enriched.length} → ${filtered.length}`
      );
    }

    /* ⭐ 金额兜底（覆盖会员退费金额字段） */
    function pickAmountSafe(d) {
      const candidates = [
        '补退金额（元）',
        '补退金额',
        '退款金额（元）',
        '退款金额',
        '报销金额',
        '借款金额（元）',
        '借款金额',
        '本次申请支付金额（元）',
        '本次申请支付金额',
        '总价款（元）',
        '金额（元）',
        '金额',
      ];
      const fv = d.formValues || {};
      for (const k of candidates) {
        const v = fv[k];
        if (v != null && v !== 'null' && v !== '') {
          const n = Number(String(v).replace(/[^\d.-]/g, ''));
          if (Number.isFinite(n) && n !== 0) return n;
        }
      }
      const n0 = Number(d.amount);
      if (Number.isFinite(n0) && n0 !== 0) return n0;
      return 0;
    }

    const results = filtered.map((d) => ({
      templateName: d.templateName,
      processCode: d.processCode,
      processInstanceId: d.processInstanceId,
      title: d.title,
      status: d.status,
      result: d.result,
      createTime: cache.normalizeDbTimeString(d.createTime) || '',
      finishTime: cache.normalizeDbTimeString(d.finishTime) || '',
      paymentUnit: d.paymentUnit,
      payeeAccount: d.payeeAccount,
      amount: pickAmountSafe(d),
      items: d.items,
      formValues: d.formValues,
      operationRecords: d.operationRecords || [],
      originatorName: d.originatorName || '',
      pendingApprovers: d.pendingApprovers || [],
      error: d.error,
      _autoAssigned: d._autoAssigned === true,
      _storeName: d._storeName || null,
      _assignReason: d._assignReason || '',
    }));

    const cost = Date.now() - t0;
    const totalAmount = results.reduce(
      (s, r) => s + Number(r.amount || 0),
      0
    );
    console.log(
      `[DingTalk][monthly] ${month}${STORE_NAME ? ' · ' + STORE_NAME : ''} 命中 ${results.length} 条 / ¥${totalAmount}，耗时 ${cost}ms`
    );

    res.json({
      errorcode: 0,
      errormsg: '获取成功',
      data: {
        month,
        store: STORE_NAME || null,
        startTime: startTs,
        endTime: endTs,
        totalTemplates: templates.length,
        /* ⭐ 与 results 里条数、金额严格一致 */
        totalCount: results.length,
        totalAmount,
        costMs: cost,
        results,
      },
    });
  } catch (error) {
    console.error('[DingTalk][monthly] 失败:', error.message);
    res.status(500).json({
      errorcode: 500,
      errormsg: error.response?.data?.errmsg || error.message || '获取失败',
    });
  }
});

module.exports = router;