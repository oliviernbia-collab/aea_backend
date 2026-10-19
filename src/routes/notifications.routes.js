const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// GET /api/notifications -- NOT-01
router.get('/', authenticate, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [
    req.user.id,
  ]);
  res.json(rows);
});

// GET /api/notifications/non-lues
router.get('/non-lues', authenticate, async (req, res) => {
  const [rows] = await pool.query('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND lu = 0', [
    req.user.id,
  ]);
  res.json(rows[0]);
});

// PATCH /api/notifications/:id/lu
router.patch('/:id/lu', authenticate, async (req, res) => {
  await pool.query('UPDATE notifications SET lu = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ message: 'Notification marquée comme lue.' });
});

// PATCH /api/notifications/tout-lire
router.patch('/tout-lire', authenticate, async (req, res) => {
  await pool.query('UPDATE notifications SET lu = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ message: 'Toutes les notifications sont marquées comme lues.' });
});

// PUT /api/notifications/preferences -- NOT-05
router.put('/preferences', authenticate, async (req, res) => {
  await pool.query('UPDATE users SET notif_preferences = ? WHERE id = ?', [JSON.stringify(req.body), req.user.id]);
  res.json({ message: 'Préférences mises à jour.' });
});

module.exports = router;
