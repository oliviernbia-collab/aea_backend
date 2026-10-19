const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const otplib = require('otplib');
const QRCode = require('qrcode');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { genererNumeroMembre } = require('../utils/numeroMembre');
const { notifyUsers } = require('../utils/notify');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, statut: user.statut, nom: user.nom, prenom: user.prenom },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// Jeton temporaire (5 min) emis apres mot de passe valide quand la 2FA est activee :
// ne donne acces a rien d'autre qu'a la validation du code a 6 chiffres.
function signTempToken(userId) {
  return jwt.sign({ id: userId, purpose: '2fa_pending' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function publicUser(user) {
  const { password_hash, ...rest } = user;
  return rest;
}

// POST /api/auth/inscription -- MEM-01, MEM-02, MEM-03, MEM-04
router.post(
  '/inscription',
  [
    body('nom').trim().notEmpty(),
    body('prenom').trim().notEmpty(),
    body('email').isEmail(),
    body('telephone').trim().notEmpty(),
    body('password').isLength({ min: 8 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { nom, prenom, email, telephone, password, filiere, niveau, promotion } = req.body;
    try {
      const [existing] = await pool.query('SELECT id FROM users WHERE email = ? OR telephone = ?', [email, telephone]);
      if (existing.length) {
        return res.status(409).json({ message: 'Un compte existe déjà avec cet e-mail ou ce téléphone.' });
      }

      const numeroMembre = await genererNumeroMembre();
      const passwordHash = await bcrypt.hash(password, 10);

      const [result] = await pool.query(
        `INSERT INTO users (numero_membre, nom, prenom, email, telephone, password_hash, filiere, niveau, promotion, role, statut)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'membre', 'en_attente')`,
        [numeroMembre, nom, prenom, email, telephone, passwordHash, filiere || null, niveau || null, promotion || null]
      );

      const [secretaires] = await pool.query(
        `SELECT id FROM users WHERE role IN ('secretaire_general', 'super_admin') AND statut = 'actif'`
      );
      await notifyUsers(
        secretaires.map((s) => s.id),
        {
          type: 'inscription',
          titre: 'Nouvelle inscription à valider',
          contenu: `${prenom} ${nom} (${numeroMembre}) a demandé son inscription.`,
          lien: `/administration/membres/${result.insertId}`,
        }
      );

      res.status(201).json({
        message: 'Inscription enregistrée. Elle sera validée par le Secrétaire Général.',
        numeroMembre,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Erreur lors de l'inscription." });
    }
  }
);

// POST /api/auth/connexion -- MEM-02
router.post(
  '/connexion',
  [body('identifiant').notEmpty(), body('password').notEmpty()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { identifiant, password } = req.body;
    try {
      const [rows] = await pool.query('SELECT * FROM users WHERE email = ? OR telephone = ?', [
        identifiant,
        identifiant,
      ]);
      if (!rows.length) return res.status(401).json({ message: 'Identifiants incorrects.' });

      const user = rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ message: 'Identifiants incorrects.' });

      if (user.statut === 'en_attente') {
        return res.status(403).json({ message: "Votre inscription est en attente de validation par le bureau." });
      }
      if (user.statut === 'suspendu' || user.statut === 'inactif') {
        return res.status(403).json({ message: 'Votre compte est suspendu ou inactif. Contactez le bureau.' });
      }

      if (user.two_fa_enabled) {
        return res.json({ requiresTwoFactor: true, tempToken: signTempToken(user.id) });
      }

      const token = signToken(user);
      res.json({ token, user: publicUser(user) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Erreur lors de la connexion.' });
    }
  }
);

// GET /api/auth/moi
router.get('/moi', authenticate, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!rows.length) return res.status(404).json({ message: 'Membre introuvable.' });
  res.json(publicUser(rows[0]));
});

// POST /api/auth/mot-de-passe-oublie -- MEM-02 recuperation
router.post('/mot-de-passe-oublie', [body('identifiant').notEmpty()], async (req, res) => {
  const { identifiant } = req.body;
  const [rows] = await pool.query('SELECT id FROM users WHERE email = ? OR telephone = ?', [identifiant, identifiant]);
  if (rows.length) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)', [
      rows[0].id,
      token,
      expiresAt,
    ]);
    // NOTE: envoi reel par SMS/e-mail a brancher sur un fournisseur (voir NOT-04, 5.1)
    console.log(`[reset-password] token pour user ${rows[0].id}: ${token}`);
  }
  res.json({ message: 'Si ce compte existe, des instructions ont été envoyées.' });
});

// PUT /api/auth/mot-de-passe -- changement de mot de passe par le membre connecte
router.put(
  '/mot-de-passe',
  authenticate,
  [body('motDePasseActuel').notEmpty(), body('nouveauMotDePasse').isLength({ min: 8 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { motDePasseActuel, nouveauMotDePasse } = req.body;
    try {
      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
      if (!rows.length) return res.status(404).json({ message: 'Membre introuvable.' });

      const valid = await bcrypt.compare(motDePasseActuel, rows[0].password_hash);
      if (!valid) return res.status(400).json({ message: 'Mot de passe actuel incorrect.' });

      const passwordHash = await bcrypt.hash(nouveauMotDePasse, 10);
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.user.id]);
      res.json({ message: 'Mot de passe mis à jour.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Erreur lors du changement de mot de passe.' });
    }
  }
);

router.post(
  '/reinitialiser-mot-de-passe',
  [body('token').notEmpty(), body('password').isLength({ min: 8 })],
  async (req, res) => {
    const { token, password } = req.body;
    const [rows] = await pool.query(
      'SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > NOW()',
      [token]
    );
    if (!rows.length) return res.status(400).json({ message: 'Lien invalide ou expiré.' });

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, rows[0].user_id]);
    await pool.query('UPDATE password_resets SET used = 1 WHERE id = ?', [rows[0].id]);
    res.json({ message: 'Mot de passe mis à jour.' });
  }
);

// POST /api/auth/2fa/verifier -- 2e etape de connexion : verifie le code a 6 chiffres et emet le jeton final
router.post('/2fa/verifier', [body('tempToken').notEmpty(), body('code').notEmpty()], async (req, res) => {
  try {
    const { tempToken, code } = req.body;
    let payload;
    try {
      payload = jwt.verify(tempToken, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: 'Session de connexion expirée, recommencez.' });
    }
    if (payload.purpose !== '2fa_pending') return res.status(400).json({ message: 'Jeton invalide.' });

    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [payload.id]);
    if (!rows.length || !rows[0].two_fa_enabled) return res.status(400).json({ message: 'Double authentification non active.' });

    const user = rows[0];
    const resultat = await otplib.verify({ secret: user.two_fa_secret, token: String(code).trim() });
    if (!resultat.valid) return res.status(401).json({ message: 'Code incorrect ou expiré.' });

    const token = signToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Erreur lors de la vérification du code.' });
  }
});

// POST /api/auth/2fa/init -- genere un secret TOTP et le QR code a scanner (Google/Microsoft Authenticator...)
router.post('/2fa/init', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ message: 'Membre introuvable.' });
    if (rows[0].two_fa_enabled) return res.status(400).json({ message: 'La double authentification est déjà active.' });

    const secret = otplib.generateSecret();
    await pool.query('UPDATE users SET two_fa_secret = ? WHERE id = ?', [secret, req.user.id]);

    const otpauth = otplib.generateURI({ issuer: 'AEA - Espace Membre', label: rows[0].email, secret });
    const qrCode = await QRCode.toDataURL(otpauth);
    res.json({ secret, qrCode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur lors de l'initialisation de la double authentification." });
  }
});

// POST /api/auth/2fa/activer -- confirme l'activation avec un premier code valide
router.post('/2fa/activer', authenticate, [body('code').notEmpty()], async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!rows.length || !rows[0].two_fa_secret) return res.status(400).json({ message: "Initialisez d'abord la double authentification." });

    const resultat = await otplib.verify({ secret: rows[0].two_fa_secret, token: String(req.body.code).trim() });
    if (!resultat.valid) return res.status(400).json({ message: 'Code incorrect.' });

    await pool.query('UPDATE users SET two_fa_enabled = 1 WHERE id = ?', [req.user.id]);
    res.json({ message: 'Double authentification activée.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur lors de l'activation de la double authentification." });
  }
});

// POST /api/auth/2fa/desactiver -- exige un code valide (preuve de possession) pour desactiver
router.post('/2fa/desactiver', authenticate, [body('code').notEmpty()], async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!rows.length || !rows[0].two_fa_enabled) return res.status(400).json({ message: 'Double authentification non active.' });

    const resultat = await otplib.verify({ secret: rows[0].two_fa_secret, token: String(req.body.code).trim() });
    if (!resultat.valid) return res.status(400).json({ message: 'Code incorrect.' });

    await pool.query('UPDATE users SET two_fa_enabled = 0, two_fa_secret = NULL WHERE id = ?', [req.user.id]);
    res.json({ message: 'Double authentification désactivée.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Erreur lors de la désactivation de la double authentification." });
  }
});

module.exports = router;
