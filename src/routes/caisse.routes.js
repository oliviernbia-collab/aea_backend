const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { makeUploader } = require('../middleware/upload');
const { logAudit } = require('../utils/audit');
const { notifyUsers, broadcast } = require('../utils/notify');

const router = express.Router();
const uploadJustificatif = makeUploader('justificatifs');

const SEUIL_DOUBLE_VALIDATION = 25000;

// Les frais de transaction en ligne (surcharge compensant la commission Jeko, voir
// FRAIS_PLATEFORME_FCFA) sont visibles dans le detail des operations pour la tracabilite, mais
// exclus des totaux/soldes affiches : seules les sommes definies par l'admin (bareme cotisations,
// operations manuelles) comptent dans le solde de l'association.
const EXCLURE_FRAIS_TRANSACTION = "AND categorie <> 'Frais de transaction'";

async function calculerSolde() {
  const [rows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'entree' THEN montant ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN type = 'sortie' THEN montant ELSE 0 END), 0) AS solde
     FROM caisse_operations WHERE statut = 'validee' ${EXCLURE_FRAIS_TRANSACTION}`
  );
  return Number(rows[0].solde);
}

// GET /api/caisse/solde -- CAI-01, CAI-06 (par fonds)
router.get('/solde', authenticate, async (req, res) => {
  const solde = await calculerSolde();
  const [parFonds] = await pool.query(
    `SELECT fonds,
       COALESCE(SUM(CASE WHEN type = 'entree' THEN montant ELSE 0 END), 0) -
       COALESCE(SUM(CASE WHEN type = 'sortie' THEN montant ELSE 0 END), 0) AS solde
     FROM caisse_operations WHERE statut = 'validee' ${EXCLURE_FRAIS_TRANSACTION} GROUP BY fonds`
  );
  res.json({ solde, parFonds });
});

// GET /api/caisse/mois-courant -- CAI-02
router.get('/mois-courant', authenticate, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'entree' THEN montant ELSE 0 END), 0) AS entrees,
       COALESCE(SUM(CASE WHEN type = 'sortie' THEN montant ELSE 0 END), 0) AS sorties
     FROM caisse_operations
     WHERE statut = 'validee' AND MONTH(date_operation) = MONTH(CURDATE()) AND YEAR(date_operation) = YEAR(CURDATE()) ${EXCLURE_FRAIS_TRANSACTION}`
  );
  res.json(rows[0]);
});

// GET /api/caisse/evolution -- CAI-03 (12 derniers mois)
router.get('/evolution', authenticate, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(date_operation, '%Y-%m') AS mois,
       COALESCE(SUM(CASE WHEN type = 'entree' THEN montant ELSE -montant END), 0) AS variation
     FROM caisse_operations
     WHERE statut = 'validee' AND date_operation >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) ${EXCLURE_FRAIS_TRANSACTION}
     GROUP BY mois ORDER BY mois`
  );

  // solde cumule avant la periode
  const [avant] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'entree' THEN montant ELSE -montant END), 0) AS solde
     FROM caisse_operations WHERE statut = 'validee' AND date_operation < DATE_SUB(CURDATE(), INTERVAL 12 MONTH) ${EXCLURE_FRAIS_TRANSACTION}`
  );

  let cumul = Number(avant[0].solde);
  const evolution = rows.map((r) => {
    cumul += Number(r.variation);
    return { mois: r.mois, solde: cumul };
  });
  res.json(evolution);
});

// GET /api/caisse/operations -- CAI-04
router.get('/operations', authenticate, async (req, res) => {
  const { type, categorie, fonds, statut, date_debut, date_fin, limit = 50, offset = 0 } = req.query;
  const conditions = [];
  const params = [];
  if (type) { conditions.push('co.type = ?'); params.push(type); }
  if (categorie) { conditions.push('co.categorie = ?'); params.push(categorie); }
  if (fonds) { conditions.push('co.fonds = ?'); params.push(fonds); }
  if (statut) { conditions.push('co.statut = ?'); params.push(statut); }
  if (date_debut) { conditions.push('co.date_operation >= ?'); params.push(date_debut); }
  if (date_fin) { conditions.push('co.date_operation <= ?'); params.push(date_fin); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT co.*, u.nom AS saisi_par_nom, u.prenom AS saisi_par_prenom
     FROM caisse_operations co JOIN users u ON u.id = co.saisi_par
     ${where} ORDER BY co.date_operation DESC, co.id DESC LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  );
  res.json(rows);
});

// POST /api/caisse/operations -- saisie financiere (Tresorier), double validation > 25000 en sortie
router.post(
  '/operations',
  authenticate,
  requirePermission('caisse.saisir_operation'),
  uploadJustificatif.single('justificatif'),
  async (req, res) => {
    const { type, fonds, categorie, libelle, montant, date_operation } = req.body;
    if (!['entree', 'sortie'].includes(type)) return res.status(400).json({ message: 'Type invalide.' });

    const montantNum = Number(montant);
    if (!montantNum || montantNum <= 0) return res.status(400).json({ message: 'Montant invalide.' });

    const requiertValidation = type === 'sortie' && montantNum > SEUIL_DOUBLE_VALIDATION;
    const statutInitial = requiertValidation ? 'en_attente_validation' : 'validee';
    const justificatif = req.file ? req.file.path : null;

    const [result] = await pool.query(
      `INSERT INTO caisse_operations (type, fonds, categorie, libelle, montant, date_operation, justificatif, saisi_par, statut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [type, fonds || 'fonctionnement', categorie, libelle, montantNum, date_operation, justificatif, req.user.id, statutInitial]
    );

    await logAudit({
      tableName: 'caisse_operations',
      recordId: result.insertId,
      userId: req.user.id,
      action: 'creation',
      nouvelleValeur: { type, montant: montantNum, statut: statutInitial },
    });

    if (requiertValidation) {
      const [presidents] = await pool.query(`SELECT id FROM users WHERE role = 'president' AND statut = 'actif'`);
      await notifyUsers(
        presidents.map((p) => p.id),
        {
          type: 'validation_depense',
          titre: 'Dépense en attente de votre validation',
          contenu: `${libelle} - ${montantNum} FCFA dépasse le seuil de ${SEUIL_DOUBLE_VALIDATION} FCFA.`,
          lien: `/caisse/operations/${result.insertId}`,
        }
      );
    }

    broadcast('caisse:update');
    res.status(201).json({ id: result.insertId, statut: statutInitial });
  }
);

// PATCH /api/caisse/operations/:id/valider -- validation President (double validation)
router.patch('/operations/:id/valider', authenticate, requirePermission('caisse.valider_operation'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM caisse_operations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Opération introuvable.' });
  if (rows[0].statut !== 'en_attente_validation') {
    return res.status(400).json({ message: "Cette opération n'attend pas de validation." });
  }

  await pool.query('UPDATE caisse_operations SET statut = ?, valide_par = ? WHERE id = ?', [
    'validee',
    req.user.id,
    req.params.id,
  ]);
  await logAudit({
    tableName: 'caisse_operations',
    recordId: req.params.id,
    userId: req.user.id,
    action: 'validation',
    nouvelleValeur: { statut: 'validee' },
  });
  await notifyUsers([rows[0].saisi_par], {
    type: 'depense_validee',
    titre: 'Dépense validée par le Président',
    contenu: `${rows[0].libelle} - ${rows[0].montant} FCFA`,
  });

  broadcast('caisse:update');
  res.json({ message: 'Opération validée.' });
});

// POST /api/caisse/operations/:id/annuler -- pas de suppression, ecriture d'annulation (regle de confiance)
router.post('/operations/:id/annuler', authenticate, requirePermission('caisse.annuler_operation'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM caisse_operations WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Opération introuvable.' });
  const original = rows[0];
  if (original.statut === 'annulee') return res.status(400).json({ message: 'Opération déjà annulée.' });

  const typeInverse = original.type === 'entree' ? 'sortie' : 'entree';
  const [result] = await pool.query(
    `INSERT INTO caisse_operations (type, fonds, categorie, libelle, montant, date_operation, saisi_par, statut, operation_annulee_id)
     VALUES (?, ?, ?, ?, ?, CURDATE(), ?, 'validee', ?)`,
    [typeInverse, original.fonds, original.categorie, `Annulation: ${original.libelle}`, original.montant, req.user.id, original.id]
  );
  await pool.query('UPDATE caisse_operations SET statut = ? WHERE id = ?', ['annulee', original.id]);

  await logAudit({
    tableName: 'caisse_operations',
    recordId: original.id,
    userId: req.user.id,
    action: 'annulation',
    ancienneValeur: original,
    nouvelleValeur: { ecritureAnnulationId: result.insertId },
  });

  broadcast('caisse:update');
  res.json({ message: 'Opération annulée via une écriture inverse visible.', ecritureAnnulationId: result.insertId });
});

// POST /api/caisse/signalements -- signalement d'anomalie par un membre
router.post('/signalements', authenticate, async (req, res) => {
  const { operation_id, message } = req.body;
  if (!message) return res.status(400).json({ message: 'Message requis.' });

  const [result] = await pool.query(
    'INSERT INTO signalements (membre_id, operation_id, message) VALUES (?, ?, ?)',
    [req.user.id, operation_id || null, message]
  );

  const [bureau] = await pool.query(
    `SELECT id FROM users WHERE role IN ('tresorier', 'president', 'super_admin') AND statut = 'actif'`
  );
  await notifyUsers(bureau.map((b) => b.id), {
    type: 'signalement',
    titre: 'Anomalie signalée par un membre',
    contenu: message,
  });

  res.status(201).json({ id: result.insertId });
});

module.exports = router;
