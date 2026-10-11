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

module.exports = router;