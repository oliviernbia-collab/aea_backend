const express = require('express');
const pool = require('../config/db');
const { authenticate, BUREAU_ROLES } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { makeUploader } = require('../middleware/upload');
const { notifyUser, notifyUsers } = require('../utils/notify');

const router = express.Router();
const uploadPieceJointe = makeUploader('messages');

let ioInstance = null;
function setIo(io) {
  ioInstance = io;
}

// GET /api/messages/conversations -- liste des conversations privees de l'utilisateur
router.get('/conversations', authenticate, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT DISTINCT u.id, u.nom, u.prenom, u.photo, u.role
     FROM messages m
     JOIN users u ON u.id = IF(m.expediteur_id = ?, m.destinataire_id, m.expediteur_id)
     WHERE m.scope = 'prive' AND (m.expediteur_id = ? OR m.destinataire_id = ?)
     ORDER BY u.nom`,
    [req.user.id, req.user.id, req.user.id]
  );
  res.json(rows);
});

// GET /api/messages/prive/:userId -- MSG-01, MSG-02
router.get('/prive/:userId', authenticate, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM messages
     WHERE scope = 'prive' AND ((expediteur_id = ? AND destinataire_id = ?) OR (expediteur_id = ? AND destinataire_id = ?))
     ORDER BY created_at ASC`,
    [req.user.id, req.params.userId, req.params.userId, req.user.id]
  );
  res.json(rows);
});

// GET /api/messages/broadcast -- MSG-03 messages du bureau
router.get('/broadcast', authenticate, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT m.*, u.nom AS auteur_nom, u.prenom AS auteur_prenom,
       EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?) AS lu
     FROM messages m JOIN users u ON u.id = m.expediteur_id
     WHERE m.scope IN ('broadcast', 'groupe') ORDER BY m.created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json(rows);
});

// POST /api/messages/prive -- MSG-01, MSG-02
router.post('/prive', authenticate, uploadPieceJointe.single('piece_jointe'), async (req, res) => {
  const { destinataire_id, contenu } = req.body;
  if (!destinataire_id || !contenu) return res.status(400).json({ message: 'Destinataire et contenu requis.' });

  const [dest] = await pool.query('SELECT role FROM users WHERE id = ?', [destinataire_id]);
  const isBureau = BUREAU_ROLES.includes(req.user.role);
  const destEstBureau = dest.length && BUREAU_ROLES.includes(dest[0].role);
  // MSG-01: membre <-> bureau toujours autorise. MSG-02 (membre <-> membre) suppose active en V1.
  if (!isBureau && !destEstBureau) {
    // messages entre simples membres : autorise (MSG-02)
  }

  const pieceJointe = req.file ? req.file.path : null;
  const [result] = await pool.query(
    `INSERT INTO messages (expediteur_id, destinataire_id, scope, contenu, piece_jointe) VALUES (?, ?, 'prive', ?, ?)`,
    [req.user.id, destinataire_id, contenu, pieceJointe]
  );

  const message = { id: result.insertId, expediteur_id: req.user.id, destinataire_id: Number(destinataire_id), contenu, piece_jointe: pieceJointe, created_at: new Date() };
  if (ioInstance) ioInstance.to(`user:${destinataire_id}`).emit('message:prive', message);

  await notifyUser(destinataire_id, { type: 'message', titre: 'Nouveau message', contenu: contenu.slice(0, 100), lien: '/messagerie' });
  res.status(201).json(message);
});

// POST /api/messages/broadcast -- MSG-03, MSG-04 (bureau -> tous ou groupe cible)
router.post(
  '/broadcast',
  authenticate,
  requirePermission('messages.diffuser'),
  uploadPieceJointe.single('piece_jointe'),
  async (req, res) => {
    const { contenu, groupe_cible, cible_type } = req.body;
    if (!contenu) return res.status(400).json({ message: 'Contenu requis.' });

    const scope = groupe_cible ? 'groupe' : 'broadcast';
    const pieceJointe = req.file ? req.file.path : null;

    const [result] = await pool.query(
      `INSERT INTO messages (expediteur_id, scope, groupe_cible, contenu, piece_jointe) VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, scope, groupe_cible || null, contenu, pieceJointe]
    );

    let destinataires;
    if (groupe_cible) {
      const champ = cible_type === 'filiere' ? 'filiere' : 'promotion';
      [destinataires] = await pool.query(`SELECT id FROM users WHERE ${champ} = ? AND statut = 'actif'`, [groupe_cible]);
    } else {
      [destinataires] = await pool.query(`SELECT id FROM users WHERE statut = 'actif'`);
    }

    const ids = destinataires.map((d) => d.id);
    await notifyUsers(ids, { type: 'message_bureau', titre: 'Message du bureau', contenu: contenu.slice(0, 100), lien: '/messagerie' });
    if (ioInstance) ids.forEach((id) => ioInstance.to(`user:${id}`).emit('message:broadcast', { id: result.insertId, contenu, groupe_cible }));

    res.status(201).json({ id: result.insertId });
  }
);

// PATCH /api/messages/:id/lu -- MSG-06 indicateur de lecture
router.patch('/:id/lu', authenticate, async (req, res) => {
  await pool.query('INSERT IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)', [req.params.id, req.user.id]);
  res.json({ message: 'Marque comme lu.' });
});

// POST /api/messages/:id/signaler -- MSG-07 signalement / moderation
router.post('/:id/signaler', authenticate, async (req, res) => {
  await pool.query('UPDATE messages SET signale = 1 WHERE id = ?', [req.params.id]);
  const [bureau] = await pool.query(`SELECT id FROM users WHERE role IN ('president','secretaire_general','super_admin') AND statut = 'actif'`);
  await notifyUsers(bureau.map((b) => b.id), { type: 'message_signale', titre: 'Message signale', lien: `/messagerie/moderation` });
  res.json({ message: 'Message signale au bureau.' });
});

module.exports = { router, setIo };
