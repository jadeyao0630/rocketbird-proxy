'use strict';
const express = require('express');
const { pool } = require('../db');
const router = express.Router();
const CATEGORIES = new Set(['工资底薪佣金','物业费','电费','水费','修理','日常支出','退费','其它']);
let initialized = null;
function ensureTable() {
  if (!initialized) initialized = pool.query(`CREATE TABLE IF NOT EXISTS dingtalk_manual_category (
    process_instance_id VARCHAR(128) NOT NULL PRIMARY KEY,
    category VARCHAR(64) NOT NULL,
    updated_by VARCHAR(128) DEFAULT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(e => { initialized=null; throw e; });
  return initialized;
}
router.get('/dingtalk/manual-category', async (req,res) => {
  try {
    const ids = [...new Set(String(req.query.ids || '').split(',').map(x=>x.trim()).filter(Boolean))].slice(0,200);
    if (!ids.length) return res.json({errorcode:0,data:{categories:{}}});
    await ensureTable();
    const placeholders = ids.map(()=>'?').join(',');
    const [rows] = await pool.query(`SELECT process_instance_id, category FROM dingtalk_manual_category WHERE process_instance_id IN (${placeholders})`, ids);
    res.json({errorcode:0,data:{categories:Object.fromEntries(rows.map(r=>[r.process_instance_id,r.category]))}});
  } catch(e) { console.error('[manual-category][get]',e); res.status(500).json({errorcode:500,errormsg:'读取人工分类失败'}); }
});
router.post('/dingtalk/manual-category', async (req,res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(x=>String(x).trim()).filter(Boolean))];
    const category = req.body?.category == null || req.body.category === '' ? null : String(req.body.category).trim();
    if (!ids.length || ids.length > 200 || ids.some(x=>x.length>128)) return res.status(400).json({errorcode:400,errormsg:'流程ID数量或格式不正确'});
    if (category !== null && !CATEGORIES.has(category)) return res.status(400).json({errorcode:400,errormsg:'无效分类'});
    await ensureTable();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (category === null) {
        await conn.query(`DELETE FROM dingtalk_manual_category WHERE process_instance_id IN (${ids.map(()=>'?').join(',')})`,ids);
      } else {
        for (const id of ids) await conn.query(`INSERT INTO dingtalk_manual_category (process_instance_id,category) VALUES (?,?) ON DUPLICATE KEY UPDATE category=VALUES(category)`,[id,category]);
      }
      await conn.commit();
    } catch(e) { await conn.rollback(); throw e; } finally {conn.release();}
    res.json({errorcode:0,data:{count:ids.length,category}});
  } catch(e) { console.error('[manual-category][post]',e); res.status(500).json({errorcode:500,errormsg:'保存人工分类失败'}); }
});
module.exports=router;
