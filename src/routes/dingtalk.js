const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const cache = require('../services/dingtalkCache');
const dingtalkSync = require('../services/dingtalkSync');

const DINGTALK_APP_KEY = process.env.DINGTALK_APP_KEY;
const DINGTALK_APP_SECRET = process.env.DINGTALK_APP_SECRET;

if (!DINGTALK_APP_KEY || !DINGTALK_APP_SECRET) {
  console.warn(
    '[DingTalk] ⚠️ 缺少配置：DINGTALK_APP_KEY / DINGTALK_APP_SECRET，请在 .env 里设置'
  );
}

const TEMPLATE_CACHE_FILE = path.join(
  __dirname,
  '..',
  'data',
  'dingtalk_templates.json'
);

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
    fs.writeFileSync(
      TEMPLATE_CACHE_FILE,
      JSON.stringify(templates, null, 2),
      'utf-8'
    );
    console.log(`[DingTalk] 模板缓存已更新：${templates.length} 个`);
  } catch (e) {
    console.error('[DingTalk] 写入模板缓存失败:', e.message);
  }
}

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

const userNameCache = new Map();

async function fetchUserName(userId) {
  if (!userId) return '';
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  if (String(userId).length > 30) {
    userNameCache.set(userId, '');
    return '';
  }
  try {
    const accessToken = await getAccessToken();
    const url = `https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${accessToken}`;
    const response = await axios.post(url, { userid: userId });
    const data = response.data;
    if (data.errcode === 0 && data.result?.name) {
      const name = data.result.name;
      userNameCache.set(userId, name);
      return name;
    }
    userNameCache.set(userId, '');
    return '';
  } catch (e) {
    userNameCache.set(userId, '');
    return '';
  }
}

async function enrichOperationRecords(records) {
  if (!Array.isArray(records) || records.length === 0) return records;
  const uniqueIds = Array.from(
    new Set(records.map((r) => r.userId).filter(Boolean))
  );
  const nameMap = new Map();
  await Promise.all(
    uniqueIds.map(async (id) => {
      const name = await fetchUserName(id);
      nameMap.set(id, name);
    })
  );
  return records.map((r) => ({
    ...r,
    userName: nameMap.get(r.userId) || '',
  }));
}

async function extractPendingApprovers(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const running = tasks.filter(
    (t) => String(t.task_status || '').toUpperCase() === 'RUNNING'
  );
  const result = [];
  const seen = new Set();
  for (const t of running) {
    const uid = t.userid || '';
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const name = await fetchUserName(uid);
    result.push({ userId: uid, userName: name });
  }
  return result;
}

function parseDateTime(str, isEnd = false) {
  if (!str) return null;
  if (/^\d+$/.test(String(str))) return Number(str);
  const s = String(str).trim().replace(/\//g, '-');
  const datePart = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    throw new Error(`无法解析日期：${str}`);
  }
  const timePart = isEnd ? ' 23:59:59' : ' 00:00:00';
  const d = new Date(datePart.replace(' ', 'T') + timePart + '+08:00');
  if (isNaN(d.getTime())) throw new Error(`无法解析日期时间：${str}`);
  return d.getTime();
}

async function fetchProcessInstanceIds(processCode, startTime, endTime) {
  const accessToken = await getAccessToken();
  const allIds = [];
  let nextCursor = 0;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore && pageCount < 50) {
    pageCount++;
    const url =
      'https://api.dingtalk.com/v1.0/workflow/processes/instanceIds/query';
    const payload = {
      processCode,
      startTime,
      endTime,
      nextToken: nextCursor,
      maxResults: 20,
    };
    const started = Date.now();
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
    const elapsed = Date.now() - started;
    if (elapsed < 100) {
      await new Promise((r) => setTimeout(r, 100 - elapsed));
    }
  }
  return allIds;
}

function extractPaymentUnit(formValues) {
  const keys = Object.keys(formValues);
  const norm = (k) => String(k).replace(/[\s\t]+/g, '');
  const normalizedMap = {};
  keys.forEach((k) => {
    normalizedMap[norm(k)] = formValues[k];
  });
  const candidates = ['付款单位全称', '付款单位', '付款公司', '付款主体', '付款方'];
  for (const c of candidates) {
    if (normalizedMap[c] !== undefined) return normalizedMap[c];
  }
  const fuzzy = keys.find((k) => {
    const n = norm(k);
    return (
      n.includes('付款单位') ||
      n.includes('付款公司') ||
      n.includes('付款主体') ||
      n.includes('付款方')
    );
  });
  return fuzzy ? formValues[fuzzy] : null;
}

function extractPayeeAccount(formValues) {
  const keys = Object.keys(formValues);
  const norm = (k) => String(k).replace(/[\s\t]+/g, '');
  const normalizedMap = {};
  keys.forEach((k) => {
    normalizedMap[norm(k)] = formValues[k];
  });
  const candidates = ['收款账户', '收款人', '收款方', '收款单位'];
  for (const c of candidates) {
    if (normalizedMap[c] !== undefined) return normalizedMap[c];
  }
  return null;
}

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
        else if (f.label === '金额（元）' || f.label === '金额')
          item.amount = String(f.value || '');
      });
      return item;
    });
  } catch (e) {
    return [];
  }
}

function extractAmount(formValues) {
  const norm = (k) => String(k).replace(/[\s\t]+/g, '');
  const normalizedMap = {};
  Object.keys(formValues).forEach((k) => {
    normalizedMap[norm(k)] = formValues[k];
  });
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
    if (
      normalizedMap[key] !== undefined &&
      normalizedMap[key] !== 'null' &&
      normalizedMap[key] !== ''
    ) {
      return normalizedMap[key];
    }
  }
  return null;
}

async function fetchInstanceDetail(instanceId) {
  const accessToken = await getAccessToken();
  const url = `https://oapi.dingtalk.com/topapi/processinstance/get?access_token=${accessToken}`;
  const response = await axios.post(url, { process_instance_id: instanceId });
  const data = response.data;
  if (data.errcode !== 0)
    throw new Error(`实例 ${instanceId} 获取失败：${data.errmsg}`);

  const inst = data.process_instance;
  const formValues = {};
  (inst.form_component_values || []).forEach((item) => {
    formValues[item.name] = item.value;
  });

  const rawRecords = (inst.operation_records || []).map((rec) => ({
    userId: rec.userid || '',
    type: rec.type || '',
    result: rec.result || '',
    date: rec.date || null,
    remark: rec.remark || '',
  }));

  const operationRecords = await enrichOperationRecords(rawRecords);
  const pendingApprovers = await extractPendingApprovers(inst.tasks || []);

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
    operationRecords,
    originatorName: inst.originator_name || '',
    pendingApprovers,
  };
}

/* ============================================================
 * 路由 1：获取所有审批模板
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

/* 路由 1.5：手动更新模板 */
router.post('/dingtalk/templates/refresh', async (req, res) => {
  try {
    console.log('[DingTalk] 开始从钉钉刷新模板列表…');
    const accessToken = await getAccessToken();
    const url = `https://oapi.dingtalk.com/topapi/process/listbyuserid?access_token=${accessToken}`;
    const response = await axios.post(url, { offset: 0, size: 100 });
    const raw = response.data;
    if (raw.errcode !== 0) {
      return res
        .status(500)
        .json({ errorcode: raw.errcode, errormsg: raw.errmsg });
    }
    const templates = (raw.result?.process_list || []).map((t) => ({
      name: t.name,
      processCode: t.process_code,
    }));
    writeTemplateCache(templates);
    res.json({
      errorcode: 0,
      errormsg: '更新成功',
      data: { count: templates.length, templates, source: 'dingtalk' },
    });
  } catch (error) {
    console.error('[DingTalk] 更新模板失败:', error.message);
    res.status(500).json({
      errorcode: 500,
      errormsg: error.response?.data?.errmsg || error.message || '更新失败',
    });
  }
});

/* 路由 2：单个模板拉取实例 ID */
router.get('/dingtalk/process-list', async (req, res) => {
  try {
    const { start, end, processCode } = req.query;
    if (!start || !end)
      return res.status(400).json({ errorcode: 400, errormsg: '缺少 start / end' });
    if (!processCode)
      return res.status(400).json({ errorcode: 400, errormsg: '缺少 processCode' });

    const startTs = parseDateTime(start, false);
    const endTs = parseDateTime(end, true);
    if (startTs >= endTs)
      return res.status(400).json({ errorcode: 400, errormsg: 'start 必须早于 end' });

    const maxSpan = 120 * 24 * 60 * 60 * 1000;
    if (endTs - startTs > maxSpan)
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: '时间跨度不能超过 120 天' });

    const ids = await fetchProcessInstanceIds(processCode, startTs, endTs);
    res.json({
      errorcode: 0,
      errormsg: '获取成功',
      data: {
        processCode,
        startTime: startTs,
        endTime: endTs,
        count: ids.length,
        instanceIds: ids,
      },
    });
  } catch (error) {
    console.error('[DingTalk] 拉取失败:', error.message);
    res.status(500).json({ errorcode: 500, errormsg: error.message });
  }
});

/* ============================================================
 * 路由 3：报告接口（带 sync）
 * ============================================================ */
router.get('/dingtalk/report', async (req, res) => {
  const t0 = Date.now();
  try {
    const { start, end, type, company, includeRaw, sync } = req.query;
    const needSync = String(sync || '') === '1';

    if (!start || !end) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: '缺少 start / end' });
    }

    const startTs = parseDateTime(start, false);
    const endTs = parseDateTime(end, true);

    if (startTs >= endTs) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: 'start 必须早于 end' });
    }

    const maxSpan = 120 * 24 * 60 * 60 * 1000;
    if (endTs - startTs > maxSpan) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: '时间跨度不能超过 120 天' });
    }

    let templates = readTemplateCache();
    const EXCLUDE_KEYWORDS = ['银行账户'];
    templates = templates.filter(
      (t) => t.name && !EXCLUDE_KEYWORDS.some((k) => t.name.includes(k))
    );

    if (type) {
      const keywords = String(type)
        .split(/[,，\s|]+/)
        .map((k) => k.trim())
        .filter(Boolean);
      if (keywords.length > 0) {
        templates = templates.filter(
          (t) => t.name && keywords.some((k) => t.name.includes(k))
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

    /* 路径 A：只读缓存 */
    if (!needSync) {
      const processCodes = templates.map((t) => t.processCode);
      let cached = [];
      try {
        cached = await cache.getCachedAll(startTs, endTs, processCodes);
      } catch (e) {
        console.error('[DingTalk][report][cache] 查缓存失败', e.message);
      }

      let filtered = cached;
      if (company) {
        const keyword = String(company).trim();
        filtered = filtered.filter(
          (d) => d.paymentUnit && d.paymentUnit.includes(keyword)
        );
      }

      let autoAssignedCount = 0;
      filtered = filtered.map((d) => {
        const r = dingtalkSync.resolveMemberRefundPaymentUnit(
          d.templateName,
          d.formValues || {},
          d.paymentUnit,
          d.createTime
        );
        if (r.autoAssigned) autoAssignedCount++;
        return {
          ...d,
          paymentUnit: r.paymentUnit,
          _autoAssigned: r.autoAssigned,
          _storeName: r.storeName,
          _assignReason: r.reason,
        };
      });

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
        amount: d.amount,
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
      return res.json({
        errorcode: 0,
        errormsg: '获取成功（缓存）',
        data: {
          source: 'cache',
          startTime: startTs,
          endTime: endTs,
          totalTemplates: templates.length,
          totalCount: results.length,
          autoAssignedCount,
          costMs: cost,
          results,
        },
      });
    }

    /* 路径 B：同步并查询 */
    try {
      await dingtalkSync.markRun('running', '手动同步并查询（触发中）');
    } catch (e) {
      console.warn('[DingTalk][report][sync] markRun running 失败', e.message);
    }

    try {
      const templateResults = [];
      for (const tpl of templates) {
        try {
          const ids = await fetchProcessInstanceIds(
            tpl.processCode,
            startTs,
            endTs
          );
          templateResults.push({ ...tpl, instanceIds: ids });
        } catch (e) {
          templateResults.push({ ...tpl, instanceIds: [], error: e.message });
        }
      }

      const processCodes = templateResults.map((t) => t.processCode);

      let cachedFinals = [];
      try {
        cachedFinals = await cache.getCachedFinals(
          startTs,
          endTs,
          processCodes
        );
      } catch (e) {
        console.error('[DingTalk][report][sync] 查缓存失败', e.message);
      }

      const allInstanceIds = [];
      templateResults.forEach((tr) => {
        tr.instanceIds.forEach((id) => allInstanceIds.push(id));
      });

      const finalIds = await cache
        .getFinalIds(allInstanceIds)
        .catch(() => new Set());
      const needFetchIds = allInstanceIds.filter((id) => !finalIds.has(id));

      const idToTpl = new Map();
      templateResults.forEach((tr) => {
        tr.instanceIds.forEach((id) => {
          idToTpl.set(id, { name: tr.name, code: tr.processCode });
        });
      });

      const freshDetails = [];
      const FLOW_INTERVAL_MS = 100;

      for (const id of needFetchIds) {
        const started = Date.now();
        const tpl = idToTpl.get(id) || {};
        try {
          const detail = await fetchInstanceDetail(id);
          freshDetails.push({
            templateName: tpl.name,
            processCode: tpl.code,
            ...detail,
          });
        } catch (e) {
          freshDetails.push({
            templateName: tpl.name,
            processCode: tpl.code,
            processInstanceId: id,
            error: e.message,
          });
        }
        const elapsed = Date.now() - started;
        if (elapsed < FLOW_INTERVAL_MS) {
          await new Promise((r) => setTimeout(r, FLOW_INTERVAL_MS - elapsed));
        }
      }

      try {
        const valid = freshDetails.filter((d) => !d.error);

        valid.forEach((d) => {
          const r = dingtalkSync.resolveMemberRefundPaymentUnit(
            d.templateName,
            d.formValues || {},
            d.paymentUnit,
            d.createTime
          );
          d.paymentUnit = r.paymentUnit;
          if (d.templateName === dingtalkSync.MEMBER_REFUND_TEMPLATE) {
            d.formValues = {
              ...(d.formValues || {}),
              __autoAssigned: r.autoAssigned ? '1' : '0',
              __storeName: r.storeName || '',
              __assignReason: r.reason || '',
            };
          }
        });

        const groupMap = new Map();
        valid.forEach((d) => {
          const key = `${d.templateName || ''}||${d.processCode || ''}`;
          if (!groupMap.has(key)) {
            groupMap.set(key, {
              templateName: d.templateName || '',
              processCode: d.processCode || '',
              items: [],
            });
          }
          groupMap.get(key).items.push(d);
        });

        for (const g of groupMap.values()) {
          if (g.items.length === 0) continue;
          await cache.upsertMany(g.items, g.templateName, g.processCode);
        }
      } catch (e) {
        console.error('[DingTalk][report][sync] 写缓存失败', e.message);
      }

      let filtered = [...cachedFinals, ...freshDetails];
      if (company) {
        const keyword = String(company).trim();
        filtered = filtered.filter(
          (d) => d.paymentUnit && d.paymentUnit.includes(keyword)
        );
      }

      let autoAssignedCount = 0;
      filtered = filtered.map((d) => {
        const r = dingtalkSync.resolveMemberRefundPaymentUnit(
          d.templateName,
          d.formValues || {},
          d.paymentUnit,
          d.createTime
        );
        if (r.autoAssigned) autoAssignedCount++;
        return {
          ...d,
          paymentUnit: r.paymentUnit,
          _autoAssigned: r.autoAssigned,
          _storeName: r.storeName,
          _assignReason: r.reason,
        };
      });

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
        amount: d.amount,
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
      const syncMsg = `手动同步并查询：拉取 ${freshDetails.length} 条，写入 ${freshDetails.filter((d) => !d.error).length} 条，耗时 ${cost}ms`;

      let finishedAt = '';
      try {
        await dingtalkSync.markRun('success', syncMsg);
        const cfg = await dingtalkSync.getConfig();
        finishedAt = cfg.last_run_at || '';
      } catch (e) {
        console.warn('[DingTalk][report][sync] markRun success 失败', e.message);
      }

      return res.json({
        errorcode: 0,
        errormsg: '获取成功（同步）',
        data: {
          source: 'dingtalk+sync',
          startTime: startTs,
          endTime: endTs,
          totalTemplates: templates.length,
          totalCount: results.length,
          autoAssignedCount,
          costMs: cost,
          syncResult: {
            finishedAt,
            status: 'success',
            message: syncMsg,
          },
          results,
        },
      });
    } catch (e) {
      console.error('[DingTalk][report][sync] 失败:', e.message);
      let finishedAt = '';
      try {
        await dingtalkSync.markRun('failed', e.message);
        const cfg = await dingtalkSync.getConfig();
        finishedAt = cfg.last_run_at || '';
      } catch (err) {
        console.warn('[DingTalk][report][sync] markRun failed 失败', err.message);
      }
      return res.status(500).json({
        errorcode: 500,
        errormsg: e.message || '同步失败',
        data: {
          source: 'dingtalk+sync',
          syncResult: {
            finishedAt,
            status: 'failed',
            message: e.message || '同步失败',
          },
        },
      });
    }
  } catch (error) {
    console.error('[DingTalk][report] 失败:', error.message);
    res.status(500).json({
      errorcode: 500,
      errormsg: error.response?.data?.errmsg || error.message || '获取失败',
    });
  }
});

/* ============================================================
 * 路由 6：月综合报告（按月份 + 门店读缓存）
 *   GET /api/dingtalk/monthly-summary?month=2026-09&store=富贵园
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

    /* ============================================================
     * ⭐ 门店过滤
     * ============================================================ */
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

    /* ⭐ 会员退费：paymentUnit 为空时，从表单文本里推断门店
     *   - 明确写了「哈德门」→ 哈德门
     *   - 明确写了「富贵园 / 东花市」→ 富贵园
     *   - 两者都没有（如「月卡」「期限卡」「舞蹈课」）→ 富贵园兜底
     */
    const STORE_KEYWORDS = {
      '哈德门': ['哈德门', '哈德'],
      '富贵园': ['富贵园', '富贵', '东花市'],
    };

    function inferStoreFromRefund(d) {
      const fv = d.formValues || {};
      const text = [
        fv['会员卡类型'],
        fv['退卡原因'],
        fv['收款账户'],
        fv['持卡人姓名'],
        d.title,
      ]
        .filter(Boolean)
        .join(' ');

      /* 1) 明确写了哈德门 → 哈德门 */
      if (STORE_KEYWORDS['哈德门'].some((k) => text.includes(k))) {
        return '哈德门';
      }
      /* 2) 明确写了富贵园 / 东花市 → 富贵园 */
      if (STORE_KEYWORDS['富贵园'].some((k) => text.includes(k))) {
        return '富贵园';
      }
      /* 3) 都没有 → 富贵园兜底（会员退费业务基本在富贵园） */
      return '富贵园';
    }

    let filtered = enriched;
    if (STORE_NAME && STORE_UNIT_MAP[STORE_NAME]) {
      const units = STORE_UNIT_MAP[STORE_NAME];
      filtered = enriched.filter((d) => {
        const pu = String(d.paymentUnit || '').trim();

        /* 1) 正常：paymentUnit 命中门店 */
        if (pu && units.some((u) => pu.includes(u) || u.includes(pu))) {
          return true;
        }

        /* 2) 会员退费且没有 paymentUnit：靠关键字推断门店 */
        if (d.templateName === '会员退费' && !pu) {
          const inferred = inferStoreFromRefund(d);
          return inferred === STORE_NAME;
        }

        return false;
      });
      console.log(
        `[DingTalk][monthly] 门店过滤「${STORE_NAME}」：${enriched.length} → ${filtered.length}`
      );
    }

    /* ============================================================
     * ⭐ 金额兜底（覆盖会员退费金额字段）
     * ============================================================ */
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
    const totalAmount = results.reduce((s, r) => s + Number(r.amount || 0), 0);
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