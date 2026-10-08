const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const router = express.Router();

// GET /api/journal -- journal d'activite (lecture de journal_audit, deja alimente par logAudit)
router.get('/', authenticate, requirePermission('journal.consulter'), async (req, res) => {
  const { table, action, limit = 100, offset = 0 } = req.query;
  const conditions = [];
  const params = [];
  if (table) { conditions.push('j.table_name = ?'); params.push(table); }
  if (action) { conditions.push('j.action = ?'); params.push(action); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT j.id, j.table_name, j.record_id, j.action, j.ancienne_valeur, j.nouvelle_valeur, j.created_at,
            u.nom AS auteur_nom, u.prenom AS auteur_prenom, u.role AS auteur_role
     FROM journal_audit j JOIN users u ON u.id = j.user_id
     ${where} ORDER BY j.created_at DESC, j.id DESC LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  );
  res.json(rows);
});

module.exports = router;
