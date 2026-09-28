const express = require('express');
const pool = require('../config/db');
const { authenticate, authorize, BUREAU_ROLES } = require('../middleware/auth');
const { makeUploader } = require('../middleware/upload');
const { notifyUsers, broadcast } = require('../utils/notify');

const router = express.Router();
const uploadImage = makeUploader('actualites');

// GET /api/actualites -- ACT-01..04 (public si non connecte, gere par la route publique separee)
router.get('/', authenticate, async (req, res) => {
  const { categorie } = req.query;
  const conditions = [];
  const params = [];
  if (categorie) { conditions.push('categorie = ?'); params.push(categorie); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT a.*, u.nom AS auteur_nom, u.prenom AS auteur_prenom
     FROM actualites a JOIN users u ON u.id = a.auteur_id
     ${where} ORDER BY a.epingle DESC, a.created_at DESC`,
    params
  );
  res.json(rows);
});

// GET /api/actualites/publiques -- page d'accueil visiteur
router.get('/publiques', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.titre, a.texte, a.image, a.categorie, a.epingle, a.created_at
     FROM actualites a WHERE a.visibilite = 'publique' ORDER BY a.epingle DESC, a.created_at DESC LIMIT 20`
  );
  res.json(rows);
});

// GET /api/actualites/:id
router.get('/:id', authenticate, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, u.nom AS auteur_nom, u.prenom AS auteur_prenom FROM actualites a JOIN users u ON u.id = a.auteur_id WHERE a.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Actualite introuvable.' });
  res.json(rows[0]);
});

// POST /api/actualites -- ACT-01, ACT-04
router.post('/', authenticate, authorize(...BUREAU_ROLES), uploadImage.single('image'), async (req, res) => {
  const { titre, texte, categorie, visibilite, epingle } = req.body;
  if (!titre || !texte || !categorie) return res.status(400).json({ message: 'Titre, texte et categorie requis.' });

  const image = req.file ? req.file.path : null;
  const [result] = await pool.query(
    `INSERT INTO actualites (titre, texte, image, categorie, auteur_id, epingle, visibilite)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [titre, texte, image, categorie, req.user.id, epingle === 'true' || epingle === true ? 1 : 0, visibilite || 'membres']
  );

  const [membres] = await pool.query(`SELECT id FROM users WHERE statut = 'actif'`);
  await notifyUsers(membres.map((m) => m.id), { type: 'actualite', titre: 'Nouvelle actualite', contenu: titre, lien: `/actualites/${result.insertId}` });

  broadcast('actualites:update');
  res.status(201).json({ id: result.insertId });
});

// PATCH /api/actualites/:id -- edition / epingler (ACT-03)
router.patch('/:id', authenticate, authorize(...BUREAU_ROLES), uploadImage.single('image'), async (req, res) => {
  const { titre, texte, categorie, visibilite, epingle } = req.body;
  const fields = [];
  const params = [];
  const map = { titre, texte, categorie, visibilite };
  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined) { fields.push(`${key} = ?`); params.push(value); }
  }
  if (epingle !== undefined) { fields.push('epingle = ?'); params.push(epingle === 'true' || epingle === true ? 1 : 0); }
  if (req.file) { fields.push('image = ?'); params.push(req.file.path); }
  if (!fields.length) return res.status(400).json({ message: 'Aucune donnee a mettre a jour.' });

  params.push(req.params.id);
  await pool.query(`UPDATE actualites SET ${fields.join(', ')} WHERE id = ?`, params);
  broadcast('actualites:update');
  res.json({ message: 'Actualite mise a jour.' });
});

// DELETE /api/actualites/:id
router.delete('/:id', authenticate, authorize(...BUREAU_ROLES), async (req, res) => {
  await pool.query('DELETE FROM actualites WHERE id = ?', [req.params.id]);
  broadcast('actualites:update');
  res.json({ message: 'Actualite supprimee.' });
});

module.exports = router;
