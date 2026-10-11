const express = require('express');
const axios = require('axios');
const router = express.Router();

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

const SYSTEM_PROMPT = `
你是健身房运营分析师。数据已经在前端以图表、卡片形式展示，你的任务是**只做文字分析与决策建议**，不要重复罗列数据明细。

输出结构（严格按此，总长度控制在 500 字以内）：

## 一句话结论
（1 句话，说明本月盈利/亏损、核心问题、最重要的行动方向）

## 核心指标速览
（只列 6~8 个最关键的指标，用无序列表，不要展开）
- 总收入：xxx 元
- 总支出：xxx 元
- 利润：xxx 元（利润率 x.x%）
- 薪酬占收入：x.x%
- 售卡 Top1 卡种：xxx（占 xx.x%）
- 售课 Top1 课种：xxx（占 xx.x%）
- 销售 Top1：xxx（占全店 xx.x%）
- 消课 Top1：xxx（占全店 xx.x%）

## 3 个最值得关注的问题
（只写 3 条，每条 2 句话：现象 + 影响或建议，用有序列表）

## 2 条行动建议
（只写 2 条，具体、可执行、带方向，用有序列表）

约束：
- 使用标准 Markdown 语法（##、-、1.、**粗体**）
- 不要输出表格（| ... |）
- 不要重复罗列数据明细（售卡/售课/部门/个人的分类和排行，图表已展示）
- 金额保留整数，百分比保留 1 位小数
- 只基于提供的数据，不编造
- 总长度不超过 500 字
`.trim();

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

    console.log(
      `[AI] 生成月报：store=${payload.storeId} month=${payload.month}`
    );

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
              JSON.stringify(payload, null, 2),
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