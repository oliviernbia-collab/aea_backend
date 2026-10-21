const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { makeUploader } = require('../middleware/upload');
const { notifyUser, broadcast } = require('../utils/notify');
const { MOIS_ADHESION, ROLES_BUREAU, FRAIS_PLATEFORME_FCFA, assurerLigneCotisation } = require('../utils/cotisations');
const { enregistrerEntreeCaisse, libellePaiement, appliquerPaiementAuxCotisations, finaliserPaiementEnLigne } = require('../services/cotisationsPaiements');
const jeko = require('../services/jeko');

const router = express.Router();
const uploadPreuve = makeUploader('preuves');

// GET /api/cotisations/config
router.get('/config', authenticate, async (req, res) => {
  const annee = req.query.annee || new Date().getFullYear();
  const [rows] = await pool.query('SELECT * FROM cotisations_config WHERE annee = ?', [annee]);
  res.json(rows[0] || null);
});

// POST /api/cotisations/config -- COT-01 (bareme differencie membre / bureau + droit d'adhesion)
router.post('/config', authenticate, requirePermission('cotisations.configurer'), async (req, res) => {
  const {
    annee, montant_membre, montant_bureau, montant_adhesion,
    numero_wave, numero_mtn_momo, numero_orange_money, numero_moov_money,
  } = req.body;
  await pool.query(
    `INSERT INTO cotisations_config
       (annee, montant_membre, montant_bureau, montant_adhesion, numero_wave, numero_mtn_momo, numero_orange_money, numero_moov_money)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE montant_membre = VALUES(montant_membre), montant_bureau = VALUES(montant_bureau),
       montant_adhesion = VALUES(montant_adhesion), numero_wave = VALUES(numero_wave),
       numero_mtn_momo = VALUES(numero_mtn_momo), numero_orange_money = VALUES(numero_orange_money),
       numero_moov_money = VALUES(numero_moov_money)`,
    [annee, montant_membre, montant_bureau, montant_adhesion, numero_wave || null, numero_mtn_momo || null, numero_orange_money || null, numero_moov_money || null]
  );

  // Initialise les 12 lignes de cotisation (bareme selon le role) + la ligne de droit d'adhesion
  // pour chaque membre actif qui n'en a pas encore pour cette annee, ET met a jour le montant du
  // des lignes pas encore payees (montant_paye = 0) pour que le nouveau bareme s'applique tout de
  // suite. Une ligne deja (partiellement) payee n'est jamais modifiee retroactivement.
  const [membres] = await pool.query(`SELECT id, role FROM users WHERE statut = 'actif'`);
  for (const m of membres) {
    const montantMensuel = ROLES_BUREAU.includes(m.role) ? montant_bureau : montant_membre;
    for (let mois = 1; mois <= 12; mois += 1) {
      await pool.query(
        `INSERT INTO cotisations (membre_id, annee, mois, montant_du, montant_paye, statut)
         VALUES (?, ?, ?, ?, 0, ?)
         ON DUPLICATE KEY UPDATE
           montant_du = IF(montant_paye = 0, VALUES(montant_du), montant_du),
           statut = IF(montant_paye = 0, VALUES(statut), statut)`,
        [m.id, annee, mois, montantMensuel, montantMensuel > 0 ? 'non_paye' : 'non_du']
      );
    }
    await pool.query(
      `INSERT INTO cotisations (membre_id, annee, mois, montant_du, montant_paye, statut)
       VALUES (?, ?, ?, ?, 0, ?)
       ON DUPLICATE KEY UPDATE
         montant_du = IF(montant_paye = 0, VALUES(montant_du), montant_du),
         statut = IF(montant_paye = 0, VALUES(statut), statut)`,
      [m.id, annee, MOIS_ADHESION, montant_adhesion, montant_adhesion > 0 ? 'non_paye' : 'non_du']
    );
  }

  broadcast('cotisations:update');
  res.json({ message: 'Configuration des cotisations mise à jour.' });
});

// GET /api/cotisations/tableau -- COT-02, COT-03 (membres x mois avec filtres)
router.get('/tableau', authenticate, async (req, res) => {
  const { annee = new Date().getFullYear(), role, filiere, statut } = req.query;

  const conditions = ["u.statut = 'actif'"];
  const params = [annee];
  if (role) { conditions.push('u.role = ?'); params.push(role); }
  if (filiere) { conditions.push('u.filiere = ?'); params.push(filiere); }

  const [rows] = await pool.query(
    `SELECT u.id AS membre_id, u.nom, u.prenom, u.numero_membre, u.promotion, u.filiere,
            c.mois, c.montant_du, c.montant_paye, c.statut
     FROM users u
     LEFT JOIN cotisations c ON c.membre_id = u.id AND c.annee = ? AND c.mois BETWEEN 1 AND 12
     WHERE ${conditions.join(' AND ')}
     ORDER BY u.nom, u.prenom, c.mois`,
    params
  );

  const membres = {};
  for (const r of rows) {
    if (!membres[r.membre_id]) {
      membres[r.membre_id] = {
        membre_id: r.membre_id,
        nom: r.nom,
        prenom: r.prenom,
        numero_membre: r.numero_membre,
        promotion: r.promotion,
        filiere: r.filiere,
        mois: {},
        totalPaye: 0,
        totalDu: 0,
        moisEnRetard: 0,
      };
    }
    if (r.mois) {
      membres[r.membre_id].mois[r.mois] = { statut: r.statut, montant_du: r.montant_du, montant_paye: r.montant_paye };
      membres[r.membre_id].totalPaye += Number(r.montant_paye || 0);
      membres[r.membre_id].totalDu += Number(r.montant_du || 0);
      if (r.statut === 'non_paye' || r.statut === 'partiel') membres[r.membre_id].moisEnRetard += 1;
    }
  }

  let resultat = Object.values(membres);
  if (statut) {
    resultat = resultat.filter((m) => Object.values(m.mois).some((mo) => mo.statut === statut));
  }

  res.json(resultat);
});

// GET /api/cotisations/adhesions -- vue bureau des droits d'adhesion (paye / non paye)
router.get('/adhesions', authenticate, requirePermission('cotisations.voir_adhesions'), async (req, res) => {
  const annee = req.query.annee || new Date().getFullYear();
  const [rows] = await pool.query(
    `SELECT u.id AS membre_id, u.nom, u.prenom, u.numero_membre, u.role,
            c.montant_du, c.montant_paye, c.statut
     FROM users u
     LEFT JOIN cotisations c ON c.membre_id = u.id AND c.annee = ? AND c.mois = ?
     WHERE u.statut = 'actif'
     ORDER BY u.nom, u.prenom`,
    [annee, MOIS_ADHESION]
  );
  res.json(rows);
});

// GET /api/cotisations/taux-recouvrement -- COT-08
router.get('/taux-recouvrement', authenticate, async (req, res) => {
  const mois = req.query.mois || new Date().getMonth() + 1;
  const annee = req.query.annee || new Date().getFullYear();

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM cotisations c JOIN users u ON u.id = c.membre_id
     WHERE c.annee = ? AND c.mois = ? AND u.statut = 'actif'`,
    [annee, mois]
  );
  const [[{ ajour }]] = await pool.query(
    `SELECT COUNT(*) AS ajour FROM cotisations c JOIN users u ON u.id = c.membre_id
     WHERE c.annee = ? AND c.mois = ? AND u.statut = 'actif' AND c.statut = 'paye'`,
    [annee, mois]
  );

  res.json({ total, ajour, taux: total ? Math.round((ajour / total) * 100) : 0 });
});

// GET /api/cotisations/ma-fiche -- Ma fiche cotisation
router.get('/ma-fiche', authenticate, async (req, res) => {
  const annee = req.query.annee || new Date().getFullYear();
  const [rows] = await pool.query('SELECT * FROM cotisations WHERE membre_id = ? AND annee = ? ORDER BY mois', [
    req.user.id,
    annee,
  ]);
  const [paiements] = await pool.query(
    'SELECT * FROM paiements WHERE membre_id = ? ORDER BY date_paiement DESC',
    [req.user.id]
  );
  res.json({
    adhesion: rows.find((r) => r.mois === MOIS_ADHESION) || null,
    mois: rows.filter((r) => r.mois !== MOIS_ADHESION),
    paiements,
  });
});

// POST /api/cotisations/paiements -- COT-05, COT-06 (saisie tresorier, recu auto ; couvre cotisations et/ou droit d'adhesion)
router.post('/paiements', authenticate, requirePermission('cotisations.saisir_paiement'), async (req, res) => {
  const { membre_id, montant, date_paiement, mode_paiement, mois_couverts } = req.body;
  if (!Array.isArray(mois_couverts) || !mois_couverts.length) {
    return res.status(400).json({ message: 'Précisez au moins un mois couvert (ou le droit d\'adhésion).' });
  }

  const recuNumero = `AEA-RECU-${Date.now()}`;
  const [result] = await pool.query(
    `INSERT INTO paiements (membre_id, montant, date_paiement, mode_paiement, mois_couverts, recu_numero, saisi_par, statut_validation)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'valide')`,
    [membre_id, montant, date_paiement, mode_paiement, JSON.stringify(mois_couverts), recuNumero, req.user.id]
  );

  const [[membre]] = await pool.query('SELECT nom, prenom FROM users WHERE id = ?', [membre_id]);
  await enregistrerEntreeCaisse({
    membreId: membre_id,
    montant,
    dateOperation: date_paiement,
    saisiPar: req.user.id,
    libelle: libellePaiement(membre, mois_couverts, recuNumero),
  });

  await appliquerPaiementAuxCotisations(membre_id, mois_couverts, montant);

  await notifyUser(membre_id, {
    type: 'paiement_recu',
    titre: 'Reçu de paiement',
    contenu: `Votre paiement de ${montant} FCFA (reçu ${recuNumero}) a été enregistré.`,
    lien: '/cotisations/ma-fiche',
  });

  broadcast('cotisations:update');
  broadcast('caisse:update');
  res.status(201).json({ id: result.insertId, recuNumero });
});

// POST /api/cotisations/declarations -- COT-09 declaration Mobile Money par le membre, a valider
router.post('/declarations', authenticate, uploadPreuve.single('preuve'), async (req, res) => {
  const { montant, date_paiement, mode_paiement, mois_couverts } = req.body;
  const moisArray = Array.isArray(mois_couverts) ? mois_couverts : [];
  if (!req.file) return res.status(400).json({ message: 'Capture d\'écran de la preuve de paiement requise.' });

  const [result] = await pool.query(
    `INSERT INTO paiements (membre_id, montant, date_paiement, mode_paiement, mois_couverts, preuve_capture, statut_validation, saisi_par)
     VALUES (?, ?, ?, ?, ?, ?, 'en_attente', ?)`,
    [req.user.id, montant, date_paiement, mode_paiement, JSON.stringify(moisArray), req.file.path, req.user.id]
  );

  const [tresoriers] = await pool.query(`SELECT id FROM users WHERE role = 'tresorier' AND statut = 'actif'`);
  await Promise.all(
    tresoriers.map((t) =>
      notifyUser(t.id, {
        type: 'declaration_paiement',
        titre: 'Déclaration de paiement Mobile Money à valider',
        contenu: `${montant} FCFA déclarés par un membre.`,
        lien: `/caisse/declarations/${result.insertId}`,
      })
    )
  );

  res.status(201).json({ id: result.insertId, message: 'Déclaration envoyée, en attente de validation du trésorier.' });
});

// PATCH /api/cotisations/declarations/:id/valider -- tresorier confirme la declaration COT-09
router.patch('/declarations/:id/valider', authenticate, requirePermission('cotisations.valider_declaration'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM paiements WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Déclaration introuvable.' });
  const paiement = rows[0];
  if (paiement.statut_validation !== 'en_attente') return res.status(400).json({ message: 'Déjà traitée.' });

  const moisCouverts = typeof paiement.mois_couverts === 'string' ? JSON.parse(paiement.mois_couverts) : paiement.mois_couverts;
  await appliquerPaiementAuxCotisations(paiement.membre_id, moisCouverts, paiement.montant);

  await pool.query("UPDATE paiements SET statut_validation = 'valide' WHERE id = ?", [req.params.id]);

  const [[membre]] = await pool.query('SELECT nom, prenom FROM users WHERE id = ?', [paiement.membre_id]);
  await enregistrerEntreeCaisse({
    membreId: paiement.membre_id,
    montant: paiement.montant,
    dateOperation: paiement.date_paiement,
    saisiPar: req.user.id,
    libelle: libellePaiement(membre, moisCouverts, 'declaration Mobile Money validee'),
  });

  await notifyUser(paiement.membre_id, {
    type: 'declaration_validee',
    titre: 'Votre déclaration de paiement a été validée',
  });

  broadcast('cotisations:update');
  broadcast('caisse:update');
  res.json({ message: 'Déclaration validée et cotisations mises à jour.' });
});

// POST /api/cotisations/paiement-en-ligne -- debit direct du compte Mobile Money du membre via Jeko (API direct)
router.post('/paiement-en-ligne', authenticate, async (req, res) => {
  const { mode_paiement, mois_couverts, payer_phone } = req.body;
  const methodesValides = ['wave', 'orange', 'mtn', 'moov'];
  if (!methodesValides.includes(mode_paiement)) {
    return res.status(400).json({ message: 'Moyen de paiement invalide.' });
  }
  if (!Array.isArray(mois_couverts) || !mois_couverts.length) {
    return res.status(400).json({ message: 'Précisez au moins un mois à payer.' });
  }
  if (!jeko.estConfigure()) {
    return res.status(503).json({ message: "Le paiement en ligne n'est pas encore configuré. Contactez le bureau." });
  }

  const telephone = jeko.normaliserTelephoneCI(payer_phone);
  if (!telephone) {
    return res.status(422).json({ message: 'Numéro mobile invalide. Format attendu : 07XXXXXXXX, 05XXXXXXXX ou 01XXXXXXXX.' });
  }

  let montant = 0;
  for (const { annee, mois } of mois_couverts) {
    const c = await assurerLigneCotisation(req.user.id, annee, mois);
    montant += Math.max(0, Number(c.montant_du) - Number(c.montant_paye));
  }
  if (montant <= 0) return res.status(400).json({ message: 'Rien à payer sur cette sélection.' });
  // Le payeur debourse le du + un forfait fixe qui compense la commission Jeko (1,5%) sur ce paiement,
  // pour que l'AEA recoive malgre tout le montant du complet.
  const montantCharge = montant + FRAIS_PLATEFORME_FCFA;
  // 1 XOF = 100 centimes (jeko://docs/payments/introduction) : amountCents est TOUJOURS en centimes,
  // meme pour le XOF. montantCharge est un nombre entier de FCFA, donc *100 est deja un multiple de 100.
  const amountCents = montantCharge * 100;

  const reference = `COT-${req.user.id}-${Date.now()}`;
  // Jeko (et les operateurs derriere) refusent une successUrl/errorUrl pointant sur localhost :
  // on passe donc par une URL publique du backend (PUBLIC_BACKEND_URL, ex. le tunnel ngrok en dev)
  // qui se contente de rediriger ensuite le navigateur vers le frontend reel (voir GET /paiement-retour).
  const basePublique = process.env.PUBLIC_BACKEND_URL;
  if (!basePublique) {
    return res.status(503).json({ message: "PUBLIC_BACKEND_URL n'est pas configuré. Contactez le bureau." });
  }

  try {
    const demande = await jeko.creerDemandePaiement({
      amountCents,
      reference,
      paymentMethod: mode_paiement,
      payerPhone: telephone,
      successUrl: `${basePublique}/api/paiement-retour?statut=succes&reference=${reference}`,
      errorUrl: `${basePublique}/api/paiement-retour?statut=erreur&reference=${reference}`,
    });

    await pool.query(
      `INSERT INTO paiements_en_ligne (membre_id, reference, jeko_payment_request_id, payment_method, montant, montant_charge, mois_couverts, statut, redirect_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [req.user.id, reference, demande.id, demande.paymentMethod, montant, montantCharge, JSON.stringify(mois_couverts), demande.redirectUrl]
    );

    res.status(201).json({ reference, redirectUrl: demande.redirectUrl, paymentMethod: demande.paymentMethod, montant, montantCharge });
  } catch (err) {
    console.error('[jeko] creation demande de paiement echouee', err.jekoId || err.message);
    res.status(502).json({ message: "Le paiement n'a pas pu être initié auprès de l'opérateur. Réessayez." });
  }
});

// GET /api/cotisations/paiement-en-ligne/:reference -- statut d'une tentative (fallback si le webhook n'est pas encore arrive)
router.get('/paiement-en-ligne/:reference', authenticate, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM paiements_en_ligne WHERE reference = ? AND membre_id = ?', [
    req.params.reference,
    req.user.id,
  ]);
  if (!rows.length) return res.status(404).json({ message: 'Paiement introuvable.' });
  let ligne = rows[0];

  if (ligne.statut === 'pending' && ligne.jeko_payment_request_id) {
    try {
      const demande = await jeko.recupererDemandePaiement(ligne.jeko_payment_request_id);
      if (demande.status !== 'pending') {
        await finaliserPaiementEnLigne(ligne.id, demande);
        const [rafraichi] = await pool.query('SELECT * FROM paiements_en_ligne WHERE id = ?', [ligne.id]);
        ligne = rafraichi[0];
      }
    } catch (err) {
      console.error('[jeko] interrogation demande de paiement echouee', err.jekoId || err.message);
    }
  }

  res.json({
    statut: ligne.statut,
    montant: ligne.montant,
    montantCharge: ligne.montant_charge,
    payment_method: ligne.payment_method,
    error_reason: ligne.error_reason,
    paiement_id: ligne.paiement_id,
  });
});

module.exports = router;
