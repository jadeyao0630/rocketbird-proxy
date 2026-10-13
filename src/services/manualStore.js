/* ============================================================
 * ⭐ 手动归属门店：读写 MySQL
 *   - 优先于「付款单位 / 关键字」自动匹配
 *   - 由用户在页面手动调整后保存
 * ============================================================ */
const { pool } = require('../db');

/* ---------- 读取单条 ---------- */
async function getManualStore(processInstanceId) {
  if (!processInstanceId) return null;
  try {
    const [rows] = await pool.query(
      `SELECT store_name FROM dingtalk_manual_store WHERE process_instance_id = ?`,
      [processInstanceId]
    );
    return rows[0]?.store_name || null;
  } catch (e) {
    console.warn('[manualStore] 读取失败', e.message);
    return null;
  }
}

/* ---------- 批量读取（推荐：报告页一次性查完） ---------- */
async function getManualStoreMap(processInstanceIds) {
  const map = new Map();
  if (!Array.isArray(processInstanceIds) || processInstanceIds.length === 0) {
    return map;
  }
  const CHUNK = 500;
  for (let i = 0; i < processInstanceIds.length; i += CHUNK) {
    const slice = processInstanceIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    try {
      const [rows] = await pool.query(
        `SELECT process_instance_id, store_name
           FROM dingtalk_manual_store
          WHERE process_instance_id IN (${placeholders})`,
        slice
      );
      rows.forEach((r) => map.set(r.process_instance_id, r.store_name));
    } catch (e) {
      console.warn('[manualStore] 批量读取失败', e.message);
    }
  }
  return map;
}

/* ---------- 写入 / 覆盖 ---------- */
async function setManualStore(processInstanceId, storeName, updatedBy) {
  if (!processInstanceId) throw new Error('缺少 processInstanceId');
  if (!storeName) throw new Error('缺少 storeName');

  await pool.query(
    `INSERT INTO dingtalk_manual_store
       (process_instance_id, store_name, updated_by, updated_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       store_name = VALUES(store_name),
       updated_by = VALUES(updated_by),
       updated_at = NOW()`,
    [String(processInstanceId), String(storeName), updatedBy || null]
  );

  return { processInstanceId, storeName };
}

/* ---------- 删除（恢复自动归属） ---------- */
async function removeManualStore(processInstanceId) {
  if (!processInstanceId) return;
  await pool.query(
    `DELETE FROM dingtalk_manual_store WHERE process_instance_id = ?`,
    [String(processInstanceId)]
  );
}

module.exports = {
  getManualStore,
  getManualStoreMap,
  setManualStore,
  removeManualStore,
};