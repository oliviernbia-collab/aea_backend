const express = require('express');
const pool = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { makeUploader } = require('../middleware/upload');
const { notifyUser, broadcast } = require('../utils/notify');
const { logAudit } = require('../utils/audit');
const { MOIS_ADHESION, ROLES_BUREAU, statutDe, assurerLigneCotisation } = require('../utils/cotisations');

const router = express.Router();
const uploadPreuve = makeUploader('preuves');

// Fait entrer un paiement de cotisation valide dans la caisse de l'association (transparence financiere, section 2 du CDC)
async function enregistrerEntreeCaisse({ membreId, montant, dateOperation, saisiPar, libelle }) {
  const [result] = await pool.query(
    `INSERT INTO caisse_operations (type, fonds, categorie, libelle, montant, date_operation, saisi_par, statut)
     VALUES ('entree', 'fonctionnement', 'Cotisation', ?, ?, ?, ?, 'validee')`,
    [libelle, montant, dateOperation, saisiPar]
  );
  await logAudit({
    tableName: 'caisse_operations',
    recordId: result.insertId,
    userId: saisiPar,
    action: 'creation',
    nouvelleValeur: { type: 'entree', categorie: 'Cotisation', montant, membreId },
  });
  return result.insertId;
}

function libellePaiement(membre, moisCouverts, suffixe) {
  const inclutAdhesion = moisCouverts.some((m) => m.mois === MOIS_ADHESION);
  const inclutMensuel = moisCouverts.some((m) => m.mois !== MOIS_ADHESION);
  let nature = 'Cotisation';
  if (inclutAdhesion && inclutMensuel) nature = "Droit d'adhesion + cotisation";
  else if (inclutAdhesion) nature = "Droit d'adhesion";
  return `${nature} - ${membre.prenom} ${membre.nom} (${suffixe})`;
}

// GET /api/cotisations/config
router.get('/config', authenticate, async (req, res) => {
  const annee = req.query.annee || new Date().getFullYear();
  const [rows] = await pool.query('SELECT * FROM cotisations_config WHERE annee = ?', [annee]);
  res.json(rows[0] || null);
});

// POST /api/cotisations/config -- COT-01 (bareme differencie membre / bureau + droit d'adhesion)
router.post('/config', authenticate, authorize('tresorier', 'super_admin'), async (req, res) => {
  const { annee, montant_membre, montant_bureau, montant_adhesion } = req.body;
  await pool.query(
    `INSERT INTO cotisations_config (annee, montant_membre, montant_bureau, montant_adhesion) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE montant_membre = VALUES(montant_membre), montant_bureau = VALUES(montant_bureau),
       montant_adhesion = VALUES(montant_adhesion)`,
    [annee, montant_membre, montant_bureau, montant_adhesion]
  );

  // Initialise les 12 lignes de cotisation (bareme selon le role) + la ligne de droit d'adhesion
  // pour chaque membre actif qui n'en a pas encore pour cette annee.
  const [membres] = await pool.query(`SELECT id, role FROM users WHERE statut = 'actif'`);
  for (const m of membres) {
    const montantMensuel = ROLES_BUREAU.includes(m.role) ? montant_bureau : montant_membre;
    for (let mois = 1; mois <= 12; mois += 1) {
      await pool.query(
        `INSERT IGNORE INTO cotisations (membre_id, annee, mois, montant_du, montant_paye, statut)
         VALUES (?, ?, ?, ?, 0, 'non_paye')`,
        [m.id, annee, mois, montantMensuel]
      );
    }
    await pool.query(
      `INSERT IGNORE INTO cotisations (membre_id, annee, mois, montant_du, montant_paye, statut)
       VALUES (?, ?, ?, ?, 0, 'non_paye')`,
      [m.id, annee, MOIS_ADHESION, montant_adhesion]
    );
  }

  broadcast('cotisations:update');
  res.json({ message: 'Configuration des cotisations mise a jour.' });
});

// GET /api/cotisations/tableau -- COT-02, COT-03 (membres x mois avec filtres)
router.get('/tableau', authenticate, async (req, res) => {
  const { annee = new Date().getFullYear(), promotion, filiere, statut } = req.query;

  const conditions = ["u.statut = 'actif'"];
  const params = [annee];
  if (promotion) { conditions.push('u.promotion = ?'); params.push(promotion); }
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
router.get('/adhesions', authenticate, authorize('tresorier', 'president', 'secretaire_general', 'super_admin'), async (req, res) => {
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
router.post('/paiements', authenticate, authorize('tresorier', 'super_admin'), async (req, res) => {
  const { membre_id, montant, date_paiement, mode_paiement, mois_couverts } = req.body;
  if (!Array.isArray(mois_couverts) || !mois_couverts.length) {
    return res.status(400).json({ message: 'Precisez au moins un mois couvert (ou le droit d\'adhesion).' });
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

  let reste = Number(montant);
  for (const { annee, mois } of mois_couverts) {
    const c = await assurerLigneCotisation(membre_id, annee, mois);
    const aPayer = Math.max(0, Number(c.montant_du) - Number(c.montant_paye));
    const affecte = Math.min(reste, aPayer);
    const nouveauPaye = Number(c.montant_paye) + affecte;
    reste -= affecte;
    await pool.query('UPDATE cotisations SET montant_paye = ?, statut = ? WHERE id = ?', [
      nouveauPaye,
      statutDe(Number(c.montant_du), nouveauPaye),
      c.id,
    ]);
  }

  await notifyUser(membre_id, {
    type: 'paiement_recu',
    titre: 'Recu de paiement',
    contenu: `Votre paiement de ${montant} FCFA (recu ${recuNumero}) a ete enregistre.`,
    lien: '/cotisations/ma-fiche',
  });

  broadcast('cotisations:update');
  broadcast('caisse:update');
  res.status(201).json({ id: result.insertId, recuNumero });
});

// POST /api/cotisations/declarations -- COT-09 declaration Mobile Money par le membre, a valider
router.post('/declarations', authenticate, uploadPreuve.single('preuve'), async (req, res) => {
  const { montant, date_paiement, mode_paiement, mois_couverts } = req.body;
  const moisArray = JSON.parse(mois_couverts || '[]');
  if (!req.file) return res.status(400).json({ message: 'Capture d\'ecran de la preuve de paiement requise.' });

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
        titre: 'Declaration de paiement Mobile Money a valider',
        contenu: `${montant} FCFA declares par un membre.`,
        lien: `/caisse/declarations/${result.insertId}`,
      })
    )
  );

  res.status(201).json({ id: result.insertId, message: 'Declaration envoyee, en attente de validation du tresorier.' });
});

// PATCH /api/cotisations/declarations/:id/valider -- tresorier confirme la declaration COT-09
router.patch('/declarations/:id/valider', authenticate, authorize('tresorier', 'super_admin'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM paiements WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Declaration introuvable.' });
  const paiement = rows[0];
  if (paiement.statut_validation !== 'en_attente') return res.status(400).json({ message: 'Deja traitee.' });

  const moisCouverts = typeof paiement.mois_couverts === 'string' ? JSON.parse(paiement.mois_couverts) : paiement.mois_couverts;
  let reste = Number(paiement.montant);
  for (const { annee, mois } of moisCouverts) {
    const c = await assurerLigneCotisation(paiement.membre_id, annee, mois);
    const aPayer = Math.max(0, Number(c.montant_du) - Number(c.montant_paye));
    const affecte = Math.min(reste, aPayer);
    const nouveauPaye = Number(c.montant_paye) + affecte;
    reste -= affecte;
    await pool.query('UPDATE cotisations SET montant_paye = ?, statut = ? WHERE id = ?', [
      nouveauPaye,
      statutDe(Number(c.montant_du), nouveauPaye),
      c.id,
    ]);
  }

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
    titre: 'Votre declaration de paiement a ete validee',
  });

  broadcast('cotisations:update');
  broadcast('caisse:update');
  res.json({ message: 'Declaration validee et cotisations mises a jour.' });
});

module.exports = router;
