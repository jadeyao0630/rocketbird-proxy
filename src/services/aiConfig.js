const { pool } = require('../db');

// 旧版 AI 分析逻辑的默认值，数据库未配置时保持原行为。
const DEFAULT_SYSTEM_PROMPT = "你是健身房运营分析师。数据已经在前端以图表、卡片形式展示，你的任务是**只做文字分析与决策建议**，不要重复罗列数据明细。\n\n**分析师背景要求**：\n- 你熟悉连锁健身房的经营模型：收入结构（售卡 / 售课 / 续费 / 私教）、成本结构（薪酬 / 固定成本 / 日常运营）、坪效与人效。\n- 你能根据**门店硬件与业态差异**给出针对性建议，而不是套话。\n- 你会把「钉钉流程中的非薪酬支出」与「门店硬件特征」结合起来解释原因。\n- 输出要像一个有 5 年以上健身房运营经验的人给出的判断，有取舍、有优先级、有可执行动作。\n\n【成本口径说明 — 必须遵守】\n\n1. **预估总支出** = 薪酬（payroll）+ 固定成本（fixedCost）\n2. **钉钉实际支出（新增）** = 退费 + 修理 + 日常支出 + 其它\n   - 不含工资底薪佣金、物业费、电费、水费，因为这四项已包含在 payroll / fixedCost 里，避免重复\n   - 钉钉的工资底薪佣金 / 物业费 / 电费 / 水费 只作为「预估 vs 实际」的对比展示，不重复计入\n3. **实际总支出** = 预估总支出 + 钉钉实际支出（新增）\n4. 「钉钉事项明细分析」段落**必须列出「预估 vs 钉钉实际」对比**，格式：\n   - **工资底薪佣金**：预估 ¥X（payroll），钉钉实际 ¥Y（N 项）\n   - **物业费**：预估 ¥X（fixedCost.propertyFee），钉钉实际 ¥Y（N 项）\n   - **电费**：预估 ¥X（fixedCost.electricityFee），钉钉实际 ¥Y（N 项）\n   - **水费**：预估 ¥X（fixedCost.waterFee），钉钉实际 ¥Y（N 项）\n   - **钉钉新增支出**：退费 / 修理 / 日常支出 / 其它，¥Z（N 项）\n5. 若「钉钉实际」明显大于或小于「预估」，必须点出，并提示用户核查是否存在跨期、重复列支、漏记等问题。\n\n输出结构（严格按此，总长度控制在 900 字以内）：\n\n## 一句话结论\n（1 句话，说明本月盈利/亏损、核心问题、最重要的行动方向）\n\n## 核心指标速览\n（只列 8~12 个最关键指标，无序列表，不要展开）\n- 总收入：xxx 元\n- 预估总支出：xxx 元\n- 钉钉实际支出（新增）：xxx 元\n- 实际总支出：xxx 元\n- 预估利润：xxx 元\n- 实际利润：xxx 元（利润率 x.x%）\n- 薪酬占收入：x.x%\n- 售卡 Top1 卡种：xxx（占 xx.x%）\n- 售课 Top1 课种：xxx（占 xx.x%）\n\n## 钉钉事项明细分析\n（**这一段必须写**，围绕下列类别逐项分析，每条 1~2 句：金额、笔数、占比、是否异常、值得关注的点）\n类别：\n- 工资底薪佣金（**必须列预估 vs 钉钉实际对比**）\n- 物业费（**必须列预估 vs 钉钉实际对比**）\n- 电费（**必须列预估 vs 钉钉实际对比**）\n- 水费（**必须列预估 vs 钉钉实际对比**）\n- 修理\n- 日常支出\n- 退费\n- 其它\n\n分析要求：\n1. 按金额从大到小列出；\n2. 每类给出金额、笔数、占钉钉总额的百分比；\n3. **结合门店硬件解释合理性**：\n   - 富贵园店：3000+ 平、含泳池/篮球场/操房/搏击区/乒乓球/私教/有氧/器械。电费、水费、保洁费、物业费、修理费偏高**属于正常**，但要判断「偏高是否与面积匹配」「单平米成本是否高于行业均值」。\n   - 哈德门店：600+ 平、含私教/有氧/器械/操房/乒乓球。若电费、水费、修理费偏高则**相对异常**，需排查设备老化、跑冒滴漏或排课冲突。\n4. **退费**类：给出笔数与金额；若金额为 0 但有笔数，明确提示「金额未体现在明细中，建议核对表单」。\n\n## 3 个最值得关注的问题\n（只写 3 条，每条 2 句话：现象 + 影响或建议，有序列表。要结合门店硬件差异，不要泛泛而谈）\n\n## 2 条行动建议\n（只写 2 条，具体、可执行、带方向，有序列表。要结合门店硬件差异）\n\n约束：\n- 使用标准 Markdown 语法（##、-、1.、**粗体**）\n- 不要输出表格（| ... |）\n- 不要重复罗列前端已展示的售卡/售课/个人排行\n- 金额保留整数，百分比保留 1 位小数\n- 只基于提供的数据，不编造\n- 总长度不超过 900 字\n\n【门店画像参考】\n数据里的 storeProfile 字段包含门店面积、硬件/业态清单、定位与关注点。请在分析中主动引用这些特征来解释数据。";
const DEFAULT_PROFILES = {
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

function parseJSON(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
function normalizeProfile(raw, name) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    name: String(p.name || name || '').slice(0, 200),
    area: String(p.area || '').slice(0, 200),
    facilities: Array.isArray(p.facilities) ? p.facilities.map(String).slice(0, 100) : [],
    positioning: String(p.positioning || '').slice(0, 5000),
    focus: Array.isArray(p.focus) ? p.focus.map(String).slice(0, 100) : [],
  };
}
async function getPrompt() {
  const [rows] = await pool.query('SELECT prompt_text FROM gym_ai_prompt_config WHERE id = 1');
  return rows.length ? rows[0].prompt_text : DEFAULT_SYSTEM_PROMPT;
}
async function savePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 50000) {
    throw new Error('提示词必须为 1~50000 字符的非空文本');
  }
  await pool.query(
    `INSERT INTO gym_ai_prompt_config (id, prompt_text) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE prompt_text = VALUES(prompt_text)`, [prompt.trim()]
  );
}
async function getProfiles() {
  const [rows] = await pool.query('SELECT store_id, profile_json FROM gym_ai_store_profile');
  return Object.fromEntries(rows.map(r => [String(r.store_id), parseJSON(r.profile_json, {})]));
}
function getDefaultProfile(storeId, storeName) {
  const key = Object.keys(DEFAULT_PROFILES).find(k => String(storeName || "").includes(k));
  return key ? normalizeProfile(DEFAULT_PROFILES[key], storeName) : normalizeProfile({}, storeName);
}
async function getProfile(storeId, storeName) {
  const [rows] = await pool.query('SELECT profile_json FROM gym_ai_store_profile WHERE store_id = ?', [String(storeId)]);
  if (rows.length) return normalizeProfile(parseJSON(rows[0].profile_json, {}), storeName);
  return getDefaultProfile(storeId, storeName);
}
async function saveProfile(storeId, raw, storeName) {
  if (!storeId || String(storeId).length > 128) throw new Error('门店 ID 无效');
  const profile = normalizeProfile(raw, storeName);
  await pool.query(
    `INSERT INTO gym_ai_store_profile (store_id, profile_json) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE profile_json = VALUES(profile_json)`,
    [String(storeId), JSON.stringify(profile)]
  );
  return profile;
}
module.exports = {
  DEFAULT_SYSTEM_PROMPT, DEFAULT_PROFILES, getDefaultProfile, normalizeProfile,
  getPrompt, savePrompt, getProfiles, getProfile, saveProfile,
};
