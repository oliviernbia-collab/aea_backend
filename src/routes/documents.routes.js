const crypto = require('crypto');
const express = require('express');
const pool = require('../config/db');
const jeko = require('../services/jeko');
const { authenticate } = require('../middleware/auth');
const { makeUploader } = require('../middleware/upload');
const { TARIFS_DOCUMENTS, finaliserCommandeDocument } = require('../services/documentsPaiements');

// Vente en ligne de CV et de cartes de visite, ouverte a tous (visiteurs sans compte compris) :
// l'acheteur remplit son document, paie via Jeko, puis telecharge le PDF genere dans son navigateur.
const router = express.Router();
const uploadPhoto = makeUploader('documents');

const MODELES = {
  cv: ['moderne', 'elegant', 'dynamique', 'eclat', 'bandeau'],
  carte_visite: ['or_noir', 'rouge', 'vague', 'neon', 'emeraude'],
};
const METHODES = ['wave', 'orange', 'mtn', 'moov'];
const TAILLE_MAX_DONNEES = 60 * 1024; // texte du document (hors photo, stockee sur Cloudinary)

function tokenValide(commande, token) {
  if (typeof token !== 'string' || token.length !== commande.acces_token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(commande.acces_token));
}

function lireDonnees(commande) {
  return typeof commande.donnees === 'string' ? JSON.parse(commande.donnees) : commande.donnees;
}

// GET /api/documents/tarifs
router.get('/tarifs', (req, res) => res.json(TARIFS_DOCUMENTS));

// POST /api/documents/commandes -- cree la commande et la demande de paiement Jeko
router.post('/commandes', uploadPhoto.single('photo'), async (req, res) => {
  const { type, modele, donnees, mode_paiement, payer_phone } = req.body;
  if (!TARIFS_DOCUMENTS[type]) return res.status(400).json({ message: 'Type de document invalide.' });
  if (!MODELES[type].includes(modele)) return res.status(400).json({ message: 'Modèle invalide.' });
  if (!METHODES.includes(mode_paiement)) return res.status(400).json({ message: 'Moyen de paiement invalide.' });
  if (!donnees || typeof donnees !== 'object' || Array.isArray(donnees)) {
    return res.status(400).json({ message: 'Contenu du document manquant.' });
  }
  if (!String(donnees.nom || '').trim() && !String(donnees.prenom || '').trim()) {
    return res.status(400).json({ message: 'Renseignez au moins votre nom.' });
  }

  const contenu = { ...donnees };
  delete contenu.photo; // seule la photo televersee ci-dessous (URL Cloudinary) est conservee
  if (req.file) contenu.photo = req.file.path;
  const json = JSON.stringify(contenu);
  if (json.length > TAILLE_MAX_DONNEES) {
    return res.status(413).json({ message: 'Le contenu du document est trop long.' });
  }

  if (!jeko.estConfigure()) {
    return res.status(503).json({ message: "Le paiement en ligne n'est pas encore configuré." });
  }
  const telephone = jeko.normaliserTelephoneCI(payer_phone);
  if (!telephone) {
    return res.status(422).json({ message: 'Numéro mobile invalide. Format attendu : 07XXXXXXXX, 05XXXXXXXX ou 01XXXXXXXX.' });
  }
  const basePublique = process.env.PUBLIC_BACKEND_URL;
  if (!basePublique) {
    return res.status(503).json({ message: "PUBLIC_BACKEND_URL n'est pas configuré." });
  }

  const montant = TARIFS_DOCUMENTS[type];
  const reference = `DOC-${type === 'cv' ? 'CV' : 'CVI'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const token = crypto.randomBytes(32).toString('hex');
  // Le jeton voyage dans l'URL de retour pour que l'acheteur retrouve son document meme si
  // l'operateur (ex. l'appli Wave) le ramene dans un autre navigateur que celui de depart.
  const retour = (statut) =>
    `${basePublique}/api/paiement-retour?statut=${statut}&reference=${reference}&token=${token}`;

  try {
    const demande = await jeko.creerDemandePaiement({
      amountCents: montant * 100, // amountCents est TOUJOURS en centimes, meme en XOF
      reference,
      paymentMethod: mode_paiement,
      payerPhone: telephone,
      successUrl: retour('succes'),
      errorUrl: retour('erreur'),
    });

    await pool.query(
      `INSERT INTO commandes_documents
        (reference, acces_token, type, modele, donnees, montant, payment_method, payer_phone, jeko_payment_request_id, redirect_url, statut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [reference, token, type, modele, json, montant, demande.paymentMethod || mode_paiement, telephone, demande.id, demande.redirectUrl]
    );

    res.status(201).json({ reference, token, redirectUrl: demande.redirectUrl, montant });
  } catch (err) {
    console.error('[jeko] creation demande (document) echouee', err.jekoId || err.message);
    res.status(502).json({ message: "Le paiement n'a pas pu être initié auprès de l'opérateur. Réessayez." });
  }
});

// GET /api/documents/commandes/:reference?token=... -- statut (re-interroge Jeko si besoin) et,
// une fois payee, le contenu du document pour en generer le PDF.
router.get('/commandes/:reference', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM commandes_documents WHERE reference = ?', [req.params.reference]);
  if (!rows.length || !tokenValide(rows[0], req.query.token)) {
    return res.status(404).json({ message: 'Commande introuvable.' });
  }
  let commande = rows[0];

  if (commande.statut === 'pending' && commande.jeko_payment_request_id) {
    try {
      const demande = await jeko.recupererDemandePaiement(commande.jeko_payment_request_id);
      if (demande.status !== 'pending') {
        await finaliserCommandeDocument(commande.id, demande);
        const [rafraichi] = await pool.query('SELECT * FROM commandes_documents WHERE id = ?', [commande.id]);
        commande = rafraichi[0];
      }
    } catch (err) {
      console.error('[jeko] interrogation demande (document) echouee', err.jekoId || err.message);
    }
  }

  res.json({
    reference: commande.reference,
    statut: commande.statut,
    type: commande.type,
    modele: commande.modele,
    montant: commande.montant,
    payment_method: commande.payment_method,
    error_reason: commande.error_reason,
    paye_le: commande.paye_le,
    // Le contenu n'est rendu qu'apres paiement : avant, le navigateur a deja l'apercu en local.
    donnees: commande.statut === 'success' ? lireDonnees(commande) : null,
  });
});

// GET /api/documents/ventes -- recettes des ventes de CV / cartes, reservees au super administrateur.
// Volontairement hors de la caisse de l'association (consultable par tous les membres).
router.get('/ventes', authenticate, async (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ message: 'Action non autorisée.' });

  const [parType] = await pool.query(
    `SELECT type, COUNT(*) AS nombre, COALESCE(SUM(montant), 0) AS total,
            COALESCE(SUM(CASE WHEN paye_le >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN montant END), 0) AS total_mois
     FROM commandes_documents WHERE statut = 'success' GROUP BY type`
  );
  const [dernieres] = await pool.query(
    `SELECT reference, type, modele, montant, payment_method, payer_phone, paye_le,
            JSON_UNQUOTE(JSON_EXTRACT(donnees, '$.prenom')) AS prenom,
            JSON_UNQUOTE(JSON_EXTRACT(donnees, '$.nom')) AS nom
     FROM commandes_documents WHERE statut = 'success' ORDER BY paye_le DESC LIMIT 100`
  );

  const resume = { cv: { nombre: 0, total: 0, total_mois: 0 }, carte_visite: { nombre: 0, total: 0, total_mois: 0 } };
  for (const l of parType) {
    resume[l.type] = { nombre: Number(l.nombre), total: Number(l.total), total_mois: Number(l.total_mois) };
  }
  res.json({
    resume,
    total: resume.cv.total + resume.carte_visite.total,
    total_mois: resume.cv.total_mois + resume.carte_visite.total_mois,
    ventes: dernieres,
  });
});

module.exports = router;
