const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { ROLES } = require('../config/permissions');
const { makeUploader } = require('../middleware/upload');
const { logAudit } = require('../utils/audit');
const { notifyUser, broadcast } = require('../utils/notify');
const { genererNumeroMembre } = require('../utils/numeroMembre');
const { assurerLignesAnnee } = require('../utils/cotisations');

const router = express.Router();
const uploadPhoto = makeUploader('photos');

const SAFE_FIELDS = `id, numero_membre, nom, prenom, email, telephone, photo, filiere, niveau, promotion, role, statut, created_at`;
const ROLES_AUTORISES = ROLES;
const STATUTS_AUTORISES = ['actif', 'inactif', 'suspendu', 'honoraire'];

function genererMotDePasseTemporaire() {
  return `${crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '')}Aa1`;
}

// GET /api/membres -- MEM-06 annuaire (recherche/filtres)
router.get('/', authenticate, async (req, res) => {
  const { q, statut, filiere, promotion } = req.query;
  const conditions = [];
  const params = [];

  if (q) {
    conditions.push('(nom LIKE ? OR prenom LIKE ? OR numero_membre LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (statut) {
    conditions.push('statut = ?');
    params.push(statut);
  }
  if (filiere) {
    conditions.push('filiere = ?');
    params.push(filiere);
  }
  if (promotion) {
    conditions.push('promotion = ?');
    params.push(promotion);
  }

  // Un membre simple ne voit que les membres actifs (masquage coordonnees geré par SAFE_FIELDS)
  if (!['super_admin', 'president', 'secretaire_general', 'tresorier', 'resp_communication'].includes(req.user.role)) {
    conditions.push("statut = 'actif'");
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.query(`SELECT ${SAFE_FIELDS} FROM users ${where} ORDER BY nom, prenom`, params);

  const isBureauViewer = ['super_admin', 'president', 'secretaire_general'].includes(req.user.role);
  const sanitized = rows.map((r) => {
    if (isBureauViewer || r.id === req.user.id) return r;
    const { email, telephone, ...rest } = r;
    return rest;
  });

  res.json(sanitized);
});

// GET /api/membres/en-attente -- MEM-01 validation d'inscription
router.get('/en-attente', authenticate, requirePermission('membres.voir_en_attente'), async (req, res) => {
  const [rows] = await pool.query(`SELECT ${SAFE_FIELDS} FROM users WHERE statut = 'en_attente' ORDER BY created_at`);
  res.json(rows);
});

// POST /api/membres -- creation directe d'un membre par le bureau (sans passer par l'auto-inscription)
router.post('/', authenticate, requirePermission('membres.creer'), async (req, res) => {
  const { nom, prenom, email, telephone, password, filiere, niveau, promotion, role, statut } = req.body;
  if (!nom || !prenom || !email || !telephone) {
    return res.status(400).json({ message: 'Nom, prénom, e-mail et téléphone sont requis.' });
  }

  const finalRole = ROLES_AUTORISES.includes(role) ? role : 'membre';
  const finalStatut = STATUTS_AUTORISES.includes(statut) ? statut : 'actif';

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ? OR telephone = ?', [email, telephone]);
    if (existing.length) {
      return res.status(409).json({ message: 'Un compte existe déjà avec cet e-mail ou ce téléphone.' });
    }

    const numeroMembre = await genererNumeroMembre();
    const motDePasseInitial = password && password.length >= 8 ? password : genererMotDePasseTemporaire();
    const passwordHash = await bcrypt.hash(motDePasseInitial, 10);

    const [result] = await pool.query(
      `INSERT INTO users (numero_membre, nom, prenom, email, telephone, password_hash, filiere, niveau, promotion, role, statut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [numeroMembre, nom, prenom, email, telephone, passwordHash, filiere || null, niveau || null, promotion || null, finalRole, finalStatut]
    );

    await logAudit({
      tableName: 'users',
      recordId: result.insertId,
      userId: req.user.id,
      action: 'creation',
      nouvelleValeur: { numeroMembre, role: finalRole, statut: finalStatut, creePar: req.user.id },
    });

    if (finalStatut === 'actif') {
      await assurerLignesAnnee(result.insertId, new Date().getFullYear());
    }

    broadcast('membres:update');
    res.status(201).json({
      message: 'Membre créé avec succès.',
      id: result.insertId,
      numeroMembre,
      motDePasseInitial,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur lors de la création du membre.' });
  }
});

// GET /api/membres/:id
router.get('/:id', authenticate, async (req, res) => {
  const [rows] = await pool.query(`SELECT ${SAFE_FIELDS} FROM users WHERE id = ?`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Membre introuvable.' });

  const isBureau = ['super_admin', 'president', 'secretaire_general'].includes(req.user.role);
  const isSelf = Number(req.params.id) === req.user.id;
  if (!isBureau && !isSelf) {
    const { email, telephone, ...rest } = rows[0];
    return res.json(rest);
  }
  res.json(rows[0]);
});

// PATCH /api/membres/:id/statut -- MEM-05 (validation inscription, suspension, etc.)
router.patch('/:id/statut', authenticate, requirePermission('membres.changer_statut'), async (req, res) => {
  const { statut } = req.body;
  const allowed = ['actif', 'inactif', 'suspendu', 'honoraire'];
  if (!allowed.includes(statut)) return res.status(400).json({ message: 'Statut invalide.' });

  const [rows] = await pool.query('SELECT statut FROM users WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Membre introuvable.' });
  const ancien = rows[0].statut;

  await pool.query('UPDATE users SET statut = ? WHERE id = ?', [statut, req.params.id]);
  await logAudit({
    tableName: 'users',
    recordId: req.params.id,
    userId: req.user.id,
    action: 'modification',
    ancienneValeur: { statut: ancien },
    nouvelleValeur: { statut },
  });

  if (ancien === 'en_attente' && statut === 'actif') {
    await assurerLignesAnnee(req.params.id, new Date().getFullYear());
    await notifyUser(req.params.id, {
      type: 'compte_valide',
      titre: 'Votre inscription a été validée',
      contenu: 'Vous pouvez désormais vous connecter à votre espace membre AEA.',
    });
  }

  broadcast('membres:update');
  res.json({ message: 'Statut mis à jour.' });
});

// PATCH /api/membres/:id/role -- gestion des roles (bureau)
router.patch('/:id/role', authenticate, requirePermission('membres.changer_role'), async (req, res) => {
  const { role } = req.body;
  if (!ROLES.includes(role)) return res.status(400).json({ message: 'Rôle invalide.' });

  await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
  await logAudit({ tableName: 'users', recordId: req.params.id, userId: req.user.id, action: 'modification', nouvelleValeur: { role } });
  broadcast('membres:update');
  res.json({ message: 'Rôle mis à jour.' });
});

// PUT /api/membres/:id -- MEM-03 mise a jour de sa propre fiche
router.put('/:id', authenticate, uploadPhoto.single('photo'), async (req, res) => {
  const isSelf = Number(req.params.id) === req.user.id;
  const isBureau = ['super_admin', 'secretaire_general'].includes(req.user.role);
  if (!isSelf && !isBureau) return res.status(403).json({ message: 'Action non autorisée.' });

  const { nom, prenom, filiere, niveau, promotion, email, telephone } = req.body;
  const fields = [];
  const params = [];
  const map = { nom, prenom, filiere, niveau, promotion, email, telephone };
  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      params.push(value);
    }
  }
  if (req.file) {
    fields.push('photo = ?');
    params.push(req.file.path);
  }
  if (!fields.length) return res.status(400).json({ message: 'Aucune donnée à mettre à jour.' });

  params.push(req.params.id);
  await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
  broadcast('membres:update');
  res.json({ message: 'Fiche membre mise à jour.' });
});

// DELETE /api/membres/:id -- droit RGPD-like (loi CI 2013-450) : suppression sur demande
router.delete('/:id', authenticate, requirePermission('membres.supprimer'), async (req, res) => {
  await pool.query(
    `UPDATE users SET nom = 'Membre', prenom = 'Supprime', email = CONCAT('supprime-', id, '@aea.local'),
     telephone = CONCAT('supprime-', id), photo = NULL, statut = 'inactif' WHERE id = ?`,
    [req.params.id]
  );
  await logAudit({ tableName: 'users', recordId: req.params.id, userId: req.user.id, action: 'modification', nouvelleValeur: { anonymise: true } });
  broadcast('membres:update');
  res.json({ message: 'Données personnelles anonymisées. Historique financier conservé anonymisé.' });
});

module.exports = router;
