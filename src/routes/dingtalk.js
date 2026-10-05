const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const DINGTALK_APP_KEY = process.env.DINGTALK_APP_KEY;
const DINGTALK_APP_SECRET = process.env.DINGTALK_APP_SECRET;

if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET) {
  console.warn(
    '[DingTalk] ⚠️ 缺少配置：DINGTALK_APP_KEY / DINGTALK_APP_SECRET，请在 .env 里设置'
  );
}

/* ============================================================
 * ⭐ 模板缓存：本地 JSON 文件
 * ============================================================ */
const TEMPLATE_CACHE_FILE = path.join(__dirname, '..', 'data', 'dingtalk_templates.json');

const DEFAULT_TEMPLATES = [
  { name: '员工借款（备用金）', processCode: 'PROC-4003F0FD-65E5-402D-88D4-10CC9FE990EE' },
  { name: '访客登记', processCode: 'PROC-2204B391-DD90-440B-81DD-D5F146D30797' },
  { name: '印章、证照、档案 使用申请', processCode: 'PROC-E359FF6E-8A63-4C84-8136-9062A0D99A7D' },
  { name: '差旅报销申请', processCode: 'PROC-AC21EDCD-971A-466A-A3D8-F516144A1CB7' },
  { name: '员工费用报销', processCode: 'PROC-75EA254D-547E-4453-A6A8-AFE3D3C3893A' },
  { name: '付款申请单', processCode: 'PROC-D50151C5-4E22-4F7E-B70F-F3A2F1C26DAB' },
  { name: '供应商合同', processCode: 'PROC-F24A8BF2-7E0F-4289-8A31-1CFCD0754087' },
  { name: '通知供应商发货单', processCode: 'PROC-340E5F83-AEF1-45F8-9AF5-5DBA60E04A23' },
  { name: '采购单', processCode: 'PROC-09334DEC-986F-406F-8483-CBFA5D5CD360' },
  { name: '出差申请', processCode: 'PROC-163D4924-AE79-4CD0-86BF-814E38840910' },
  { name: '合同用印', processCode: 'PROC-9BF7208D-5564-4803-A2B0-8AF73394E17F' },
  { name: '请示', processCode: 'PROC-B23CDEBB-1CD9-480F-AD55-82954746D1BA' },
  { name: '客户工单', processCode: 'PROC-B8298274-0DBE-4498-B7E9-738718A15E5E' },
  { name: '客户收货确认单', processCode: 'PROC-A29C650D-4D86-47E5-A3AD-048D41A9BE13' },
  { name: '客户合同', processCode: 'PROC-A41B1B32-844D-4274-A591-59844EFB3F8F' },
  { name: '银行账户（第三方账户） 开立、变更、注销', processCode: 'PROC-415E3191-DDEF-41A4-AF55-E2BC93EE9523' },
  { name: '请假单', processCode: 'PROC-27197D2E-4C7B-4092-B435-D2E2D2BA3D85' },
  { name: '会员退费', processCode: 'PROC-D6949DBC-FBCE-4D60-9CCE-402D448599F4' },
  { name: '资产报废申请表', processCode: 'PROC-68A8A85B-67AE-48AA-B9BF-65B8A3BAFE10' },
  { name: '资产调拨申请表', processCode: 'PROC-D3132C5B-5059-4116-AC2A-CB8D3B516575' },
  { name: '会签单', processCode: 'PROC-29AACFCA-462F-4E7C-AC97-95A82CCB290A' },
  { name: '资产购置申请表', processCode: 'PROC-22E5940E-4BF9-4A1C-9A41-F5BAC0670C01' },
  { name: '底薪、佣金支付申请', processCode: 'PROC-12FDF8E9-3183-4908-9962-9E61E1081EEB' },
  { name: '轻量审批-权限申请', processCode: 'PROC-D17C8636-7B5D-4C8A-961B-9D8271DB7B1A' },
];

function ensureDataDir() {
  const dir = path.dirname(TEMPLATE_CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readTemplateCache() {
  try {
    if (fs.existsSync(TEMPLATE_CACHE_FILE)) {
      const content = fs.readFileSync(TEMPLATE_CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.warn('[DingTalk] 读取模板缓存失败:', e.message);
  }
  return DEFAULT_TEMPLATES;
}

function writeTemplateCache(templates) {
  try {
    ensureDataDir();
    fs.writeFileSync(TEMPLATE_CACHE_FILE, JSON.stringify(templates, null, 2), 'utf-8');
    console.log(`[DingTalk] 模板缓存已更新：${templates.length} 个`);
  } catch (e) {
    console.error('[DingTalk] 写入模板缓存失败:', e.message);
  }
}

/* ============================================================
 * access_token 缓存
 * ============================================================ */
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET) {
    throw new Error('缺少钉钉凭证 DINGTALK_APP_KEY / DINGTALK_APP_SECRET');
  }
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }
  const response = await axios.post(
    'https://api.dingtalk.com/v1.0/oauth2/accessToken',
    { appKey: DINGTALK_APP_KEY, appSecret: DINGTALK_APP_SECRET }
  );
  const { accessToken, expireIn } = response.data;
  if (!accessToken) {
    throw new Error('获取 access_token 失败：' + JSON.stringify(response.data));
  }
  tokenCache.token = accessToken;
  tokenCache.expiresAt = Date.now() + (expireIn || 7200) * 1000;
  return accessToken;
}

/* ============================================================
 * ⭐ 日期字符串 → 毫秒时间戳
 *    - start: 默认补 00:00:00
 *    - end:   传 true 时补 23:59:59（避免漏掉当天）
 * ============================================================ */
function parseDateTime(str, isEnd = false) {
  if (!str) return null;
  if (/^\d+$/.test(String(str))) return Number(str);
  const normalized = String(str).trim().replace(/\//g, '-');
  let dateStr = normalized;
  if (normalized.length === 10) {
    dateStr = normalized + (isEnd ? ' 23:59:59' : ' 00:00:00');
  }
  const d = new Date(dateStr.replace(' ', 'T') + '+08:00');
  if (isNaN(d.getTime())) throw new Error(`无法解析日期时间：${str}`);
  return d.getTime();
}

/* 分页拉取单个 processCode 的实例 ID（新版接口，token 走 Header） */
async function fetchProcessInstanceIds(processCode, startTime, endTime) {
  const accessToken = await getAccessToken();
  const allIds = [];
  let nextCursor = 0;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore && pageCount < 50) {
    pageCount++;
    const url = 'https://api.dingtalk.com/v1.0/workflow/processes/instanceIds/query';
    const payload = { processCode, startTime, endTime, nextToken: nextCursor, maxResults: 20 };
    const response = await axios.post(url, payload, {
      headers: {
        'x-acs-dingtalk-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    });
    const data = response.data;
    if (data.result?.list) allIds.push(...data.result.list);
    nextCursor = data.result?.nextToken;
    hasMore = !!nextCursor;
  }
  return allIds;
}

/* 从 formValues 中提取"付款单位" */
function extractPaymentUnit(formValues) {
  const keys = Object.keys(formValues);
  const norm = (k) => String(k).replace(/[\s\t]+/g, '');
  const normalizedMap = {};
  keys.forEach((k) => { normalizedMap[norm(k)] = formValues[k]; });

  const candidates = ['付款单位全称', '付款单位', '付款公司', '付款主体', '付款方'];
  for (const c of candidates) {
    if (normalizedMap[c] !== undefined) return normalizedMap[c];
  }
  const fuzzy = keys.find((k) => {
    const n = norm(k);
    return n.includes('付款单位') || n.includes('付款公司') || n.includes('付款主体') || n.includes('付款方');
  });
  return fuzzy ? formValues[fuzzy] : null;
}

/* 从 formValues 中提取"收款账户" */
function extractPayeeAccount(formValues) {
  const keys = Object.keys(formValues);
  const norm = (k) => String(k).replace(/[\s\t]+/g, '');
  const normalizedMap = {};
  keys.forEach((k) => { normalizedMap[norm(k)] = formValues[k]; });
  const candidates = ['收款账户', '收款人', '收款方', '收款单位'];
  for (const c of candidates) {
    if (normalizedMap[c] !== undefined) return normalizedMap[c];
  }
  return null;
}

/* 解析"明细列表" */
function parseDetailList(formValues) {
  const raw = formValues['明细列表'];
  if (!raw || raw === 'null') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => {
      const rowValue = row.rowValue || [];
      const item = { rowNumber: row.rowNumber || '', content: '', amount: '' };
      rowValue.forEach((f) => {
        if (f.label === '事项') item.content = String(f.value || '');
        else if (f.label === '金额（元）' || f.label === '金额') item.amount = String(f.value || '');
      });
      return item;
    });
  } catch (e) {
    return [];
  }
}

/* 智能提取金额 */
function extractAmount(formValues) {
  const norm = (k) => String(k).replace(/[\s\t]+/g, '');
  const normalizedMap = {};
  Object.keys(formValues).forEach((k) => { normalizedMap[norm(k)] = formValues[k]; });

  const candidates = [
    '补退金额（元）',
    '借款金额（元）',
    '本次申请支付金额（元）',
    '报销金额',
    '总价款（元）',
    '金额（元）',
  ];
  for (const c of candidates) {
    const key = norm(c);
    if (normalizedMap[key] !== undefined && normalizedMap[key] !== 'null' && normalizedMap[key] !== '') {
      return normalizedMap[key];
    }
  }
  return null;
}

/* 获取单个实例详情 */
async function fetchInstanceDetail(instanceId) {
  const accessToken = await getAccessToken();
  const url = `https://oapi.dingtalk.com/topapi/processinstance/get?access_token=${accessToken}`;
  const response = await axios.post(url, { process_instance_id: instanceId });
  const data = response.data;

  if (data.errcode !== 0) throw new Error(`实例 ${instanceId} 获取失败：${data.errmsg}`);

  const inst = data.process_instance;
  const formValues = {};
  (inst.form_component_values || []).forEach((item) => {
    formValues[item.name] = item.value;
  });

  return {
    processInstanceId: instanceId,
    title: inst.title,
    status: inst.status,
    result: inst.result,
    createTime: inst.create_time,
    finishTime: inst.finish_time,
    originatorUserId: inst.originator_userid,
    originatorDeptId: inst.originator_dept_id,
    paymentUnit: extractPaymentUnit(formValues),
    payeeAccount: extractPayeeAccount(formValues),
    amount: extractAmount(formValues),
    items: parseDetailList(formValues),
    formValues,
  };
}

/* 从钉钉拉取模板（供"更新"接口调用） */
async function fetchTemplatesFromDingTalk() {
  const accessToken = await getAccessToken();
  const url = `https://oapi.dingtalk.com/topapi/process/listbyuserid?access_token=${accessToken}`;
  const response = await axios.post(url, { offset: 0, size: 100 });
  const data = response.data;

  console.log('========== [DingTalk] 模板接口原始返回 ==========');
  console.log(JSON.stringify(data, null, 2));
  console.log('===============================================');

  if (data.errcode !== 0) throw new Error(`获取模板失败：${data.errmsg}`);
  return (data.result?.process_list || []).map((t) => ({
    name: t.name,
    processCode: t.process_code,
  }));
}

/* ============================================================
 * 路由 1：获取所有审批模板（读本地缓存，不调钉钉）
 * ============================================================ */
router.get('/dingtalk/templates', async (req, res) => {
  try {
    const templates = readTemplateCache();
    res.json({
      errorcode: 0,
      errormsg: '获取成功',
      data: { count: templates.length, templates, source: 'cache' },
    });
  } catch (error) {
    console.error('[DingTalk] 获取模板失败:', error.message);
    res.status(500).json({ errorcode: 500, errormsg: error.message });
  }
});

/* ============================================================
 * 路由 1.5：手动更新模板
 * POST /api/dingtalk/templates/refresh
 * ============================================================ */
router.post('/dingtalk/templates/refresh', async (req, res) => {
  try {
    console.log('[DingTalk] 开始从钉钉刷新模板列表…');
    const accessToken = await getAccessToken();
    const url = `https://oapi.dingtalk.com/topapi/process/listbyuserid?access_token=${accessToken}`;
    const response = await axios.post(url, { offset: 0, size: 100 });
    const raw = response.data;

    console.log('========== [DingTalk] 刷新 · 原始返回 ==========');
    console.log(JSON.stringify(raw, null, 2));
    console.log('============================================');

    if (raw.errcode !== 0) {
      return res.status(500).json({
        errorcode: raw.errcode,
        errormsg: raw.errmsg,
      });
    }

    const templates = (raw.result?.process_list || []).map((t) => ({
      name: t.name,
      processCode: t.process_code,
    }));

    writeTemplateCache(templates);

    res.json({
      errorcode: 0,
      errormsg: '更新成功',
      data: {
        count: templates.length,
        templates,
        source: 'dingtalk',
        raw,
      },
    });
  } catch (error) {
    console.error('[DingTalk] 更新模板失败:', error.message);
    res.status(500).json({
      errorcode: 500,
      errormsg: error.response?.data?.errmsg || error.message || '更新失败',
    });
  }
});

/* ============================================================
 * 路由 1.6：调试接口 - 返回原始模板数据
 * GET /api/dingtalk/templates/raw
 * ============================================================ */
router.get('/dingtalk/templates/raw', async (req, res) => {
  try {
    console.log('[DingTalk] 拉取原始模板数据…');
    const accessToken = await getAccessToken();
    const url = `https://oapi.dingtalk.com/topapi/process/listbyuserid?access_token=${accessToken}`;
    const response = await axios.post(url, { offset: 0, size: 100 });
    const data = response.data;

    console.log('========== [DingTalk] 原始返回 ==========');
    console.log(JSON.stringify(data, null, 2));
    console.log('======================================');

    res.json({ errorcode: 0, errormsg: '获取成功', data });
  } catch (error) {
    console.error('[DingTalk] 拉原始数据失败:', error.message);
    res.status(500).json({ errorcode: 500, errormsg: error.message });
  }
});

/* ============================================================
 * 路由 2：单个模板拉取实例 ID
 * ============================================================ */
router.get('/dingtalk/process-list', async (req, res) => {
  try {
    const { start, end, processCode } = req.query;
    if (!start || !end) return res.status(400).json({ errorcode: 400, errormsg: '缺少 start / end' });
    if (!processCode) return res.status(400).json({ errorcode: 400, errormsg: '缺少 processCode' });

    /* ⭐ end 补 23:59:59 */
    const startTs = parseDateTime(start, false);
    const endTs = parseDateTime(end, true);
    if (startTs >= endTs) return res.status(400).json({ errorcode: 400, errormsg: 'start 必须早于 end' });

    const maxSpan = 120 * 24 * 60 * 60 * 1000;
    if (endTs - startTs > maxSpan) return res.status(400).json({ errorcode: 400, errormsg: '时间跨度不能超过 120 天' });

    const ids = await fetchProcessInstanceIds(processCode, startTs, endTs);
    res.json({
      errorcode: 0,
      errormsg: '获取成功',
      data: { processCode, startTime: startTs, endTime: endTs, count: ids.length, instanceIds: ids },
    });
  } catch (error) {
    console.error('[DingTalk] 拉取失败:', error.message);
    res.status(500).json({ errorcode: 500, errormsg: error.message });
  }
});

/* ============================================================
 * 路由 3：【核心】报告接口
 * ============================================================ */
router.get('/dingtalk/report', async (req, res) => {
  const t0 = Date.now();
  try {
    const { start, end, type, company, includeRaw } = req.query;

    if (!start || !end) {
      return res.status(400).json({ errorcode: 400, errormsg: '缺少 start / end' });
    }

    /* ⭐ end 补 23:59:59 */
    const startTs = parseDateTime(start, false);
    const endTs = parseDateTime(end, true);
    if (startTs >= endTs) return res.status(400).json({ errorcode: 400, errormsg: 'start 必须早于 end' });

    const maxSpan = 120 * 24 * 60 * 60 * 1000;
    if (endTs - startTs > maxSpan) {
      return res.status(400).json({ errorcode: 400, errormsg: '时间跨度不能超过 120 天' });
    }

    /* 1) 从本地缓存读模板 */
    let templates = readTemplateCache();
    console.log(`[DingTalk][report] 缓存模板数：${templates.length}`);

    /* 2) 排除黑名单 + type 关键词过滤 */
    const EXCLUDE_KEYWORDS = ['银行账户'];
    templates = templates.filter(
      (t) => t.name && !EXCLUDE_KEYWORDS.some((k) => t.name.includes(k))
    );
    console.log(`[DingTalk][report] 排除[银行账户]后：${templates.length}`);

    if (type) {
      const keywords = String(type)
        .split(/[,，\s|]+/)
        .map((k) => k.trim())
        .filter(Boolean);

      if (keywords.length > 0) {
        templates = templates.filter(
          (t) => t.name && keywords.some((k) => t.name.includes(k))
        );
        console.log(
          `[DingTalk][report] 类型过滤"${keywords.join(' / ')}" → 命中 ${templates.length} 个模板`
        );
      }
    }

    if (templates.length === 0) {
      return res.json({
        errorcode: 0,
        errormsg: '无匹配模板',
        data: { totalCount: 0, totalTemplates: 0, results: [] },
      });
    }

    /* 3) 逐个模板拉实例 ID */
    const templateResults = [];
    for (const tpl of templates) {
      try {
        const ids = await fetchProcessInstanceIds(tpl.processCode, startTs, endTs);
        templateResults.push({ ...tpl, instanceIds: ids });
        console.log(`[DingTalk][report] ${tpl.name}: ${ids.length} 个实例`);
      } catch (e) {
        templateResults.push({ ...tpl, instanceIds: [], error: e.message });
        console.error(`[DingTalk][report] ${tpl.name} 拉实例失败: ${e.message}`);
      }
    }

    /* 4) 逐个实例拉详情 */
    const allDetails = [];
    for (const tr of templateResults) {
      for (const id of tr.instanceIds) {
        try {
          const detail = await fetchInstanceDetail(id);
          allDetails.push({
            templateName: tr.name,
            processCode: tr.processCode,
            ...detail,
          });
        } catch (e) {
          allDetails.push({
            templateName: tr.name,
            processCode: tr.processCode,
            processInstanceId: id,
            error: e.message,
          });
        }
      }
    }

    /* 5) 按付款单位过滤 */
    let filtered = allDetails;
    if (company) {
      const keyword = String(company).trim();
      filtered = filtered.filter(
        (d) => d.paymentUnit && d.paymentUnit.includes(keyword)
      );
      console.log(
        `[DingTalk][report] 付款单位过滤"${keyword}"：${allDetails.length} → ${filtered.length}`
      );
    }

    /* 6) 默认只保留"已完成且同意" */
    const onlyApproved = req.query.onlyApproved !== '0';
    if (onlyApproved) {
      const before = filtered.length;
      filtered = filtered.filter(
        (d) => d.status === 'COMPLETED' && d.result === 'agree'
      );
      console.log(
        `[DingTalk][report] 只保留 COMPLETED+agree：${before} → ${filtered.length}`
      );
    }

    /* 7) 整理返回结构 */
    const results = filtered.map((d) => {
      const base = {
        templateName: d.templateName,
        processCode: d.processCode,
        processInstanceId: d.processInstanceId,
        title: d.title,
        status: d.status,
        result: d.result,
        createTime: d.createTime,
        finishTime: d.finishTime,
        paymentUnit: d.paymentUnit,
        payeeAccount: d.payeeAccount,
        amount: d.amount,
        items: d.items,
        formValues: d.formValues,
        error: d.error,
      };
      if (includeRaw === '1') {
        base.originatorUserId = d.originatorUserId;
        base.originatorDeptId = d.originatorDeptId;
      }
      return base;
    });

    const cost = Date.now() - t0;
    console.log(
      `[DingTalk][report] 完成：模板 ${templates.length} 个，实例 ${allDetails.length} 条，过滤后 ${results.length} 条，耗时 ${cost}ms`
    );

    res.json({
      errorcode: 0,
      errormsg: '获取成功',
      data: {
        startTime: startTs,
        endTime: endTs,
        filter: {
          type: type || null,
          company: company || null,
          excludeTemplates: EXCLUDE_KEYWORDS,
          onlyApproved,
        },
        totalTemplates: templates.length,
        beforeFilterCount: allDetails.length,
        totalCount: results.length,
        costMs: cost,
        results,
      },
    });
  } catch (error) {
    console.error('[DingTalk][report] 失败:', error.message);
    res.status(500).json({
      errorcode: 500,
      errormsg: error.response?.data?.errmsg || error.message || '获取失败',
    });
  }
});

/* ============================================================
 * 路由 4：单个实例详情
 * ============================================================ */
router.get('/dingtalk/instance-detail', async (req, res) => {
  try {
    const { processInstanceId } = req.query;
    if (!processInstanceId) return res.status(400).json({ errorcode: 400, errormsg: '缺少 processInstanceId' });

    const detail = await fetchInstanceDetail(processInstanceId);
    res.json({ errorcode: 0, errormsg: '获取成功', data: detail });
  } catch (error) {
    res.status(500).json({ errorcode: 500, errormsg: error.message });
  }
});

/* ============================================================
 * 路由 5：批量实例详情
 * ============================================================ */
router.post('/dingtalk/instances-detail', async (req, res) => {
  try {
    const { instanceIds } = req.body || {};
    if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
      return res.status(400).json({ errorcode: 400, errormsg: '请提供 instanceIds 数组' });
    }

    const results = [];
    for (const id of instanceIds) {
      try {
        const detail = await fetchInstanceDetail(id);
        results.push(detail);
      } catch (e) {
        results.push({ processInstanceId: id, error: e.message });
      }
    }

    res.json({ errorcode: 0, errormsg: '获取成功', data: { count: results.length, results } });
  } catch (error) {
    res.status(500).json({ errorcode: 500, errormsg: error.message });
  }
});

module.exports = router;