const pool = require('../config/db');
const { logAudit } = require('../utils/audit');
const { notifyUser, broadcast } = require('../utils/notify');
const { MOIS_ADHESION, statutDe, assurerLigneCotisation } = require('../utils/cotisations');

// Fait entrer un paiement de cotisation valide dans la caisse de l'association (transparence financiere, section 2 du CDC)
// paiementId (optionnel) relie l'ecriture de caisse au paiement d'origine (table paiements),
// pour qu'une annulation de paiement (voir annulerPaiement) retrouve et neutralise cette ecriture.
async function enregistrerEntreeCaisse({ membreId, montant, dateOperation, saisiPar, libelle, categorie = 'Cotisation', paiementId = null }) {
  const [result] = await pool.query(
    `INSERT INTO caisse_operations (type, fonds, categorie, libelle, montant, date_operation, saisi_par, statut, paiement_id)
     VALUES ('entree', 'fonctionnement', ?, ?, ?, ?, ?, 'validee', ?)`,
    [categorie, libelle, montant, dateOperation, saisiPar, paiementId]
  );
  await logAudit({
    tableName: 'caisse_operations',
    recordId: result.insertId,
    userId: saisiPar,
    action: 'creation',
    nouvelleValeur: { type: 'entree', categorie, montant, membreId },
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

// Somme des montants restant dus sur une liste de mois (cree les lignes manquantes au passage).
// A verifier AVANT d'appliquer un paiement : appliquerPaiementAuxCotisations n'affecte un
// paiement qu'aux lignes fournies dans moisCouverts, sans jamais deborder sur un autre mois --
// un montant superieur a ce qui est du sur les mois choisis doit donc etre rejete en amont
// (voir les routes), plutot que de laisser le surplus disparaitre du suivi des cotisations.
async function totalRestantDu(membreId, moisCouverts) {
  let total = 0;
  for (const { annee, mois } of moisCouverts) {
    const c = await assurerLigneCotisation(membreId, annee, mois);
    total += Math.max(0, Number(c.montant_du) - Number(c.montant_paye));
  }
  return total;
}

// Repartit un montant paye sur les lignes de cotisation couvertes, dans l'ordre fourni.
async function appliquerPaiementAuxCotisations(membreId, moisCouverts, montant) {
  let reste = Number(montant);
  for (const { annee, mois } of moisCouverts) {
    const c = await assurerLigneCotisation(membreId, annee, mois);
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
}

// Point d'entree unique pour conclure une tentative de paiement en ligne (Jeko), appele a la fois
// par le webhook (source de verite) et par le polling de secours cote GET /paiement-en-ligne/:reference.
// Idempotent : relit la ligne et ne fait rien si elle n'est plus 'pending' (deja traitee).
async function finaliserPaiementEnLigne(id, transactionJeko) {
  if (transactionJeko.status === 'pending') return;

  // Reclame la ligne avant tout effet de bord : le webhook et le polling de secours (GET) peuvent
  // arriver en meme temps, seule l'UPDATE qui trouve encore 'pending' gagne la course.
  const nouveauStatut = transactionJeko.status === 'success' ? 'success' : 'error';
  const [reclamation] = await pool.query(
    `UPDATE paiements_en_ligne SET statut = ?, error_reason = ? WHERE id = ? AND statut = 'pending'`,
    [nouveauStatut, nouveauStatut === 'error' ? (transactionJeko.errorReason || 'echec_operateur') : null, id]
  );
  if (!reclamation.affectedRows) return; // deja traite par l'autre voie

  if (nouveauStatut === 'success') {
    const [[ligne]] = await pool.query('SELECT * FROM paiements_en_ligne WHERE id = ?', [id]);
    const moisCouverts = typeof ligne.mois_couverts === 'string' ? JSON.parse(ligne.mois_couverts) : ligne.mois_couverts;
    const [[membre]] = await pool.query('SELECT nom, prenom FROM users WHERE id = ?', [ligne.membre_id]);

    const [resultPaiement] = await pool.query(
      `INSERT INTO paiements (membre_id, montant, date_paiement, mode_paiement, mois_couverts, recu_numero, saisi_par, statut_validation)
       VALUES (?, ?, CURDATE(), ?, ?, ?, ?, 'valide')`,
      [ligne.membre_id, ligne.montant, ligne.payment_method, JSON.stringify(moisCouverts), ligne.reference, ligne.membre_id]
    );

    const aujourdhui = new Date().toISOString().slice(0, 10);
    await enregistrerEntreeCaisse({
      membreId: ligne.membre_id,
      montant: ligne.montant,
      dateOperation: aujourdhui,
      saisiPar: ligne.membre_id,
      libelle: libellePaiement(membre, moisCouverts, `paiement en ligne ${ligne.payment_method}`),
      paiementId: resultPaiement.insertId,
    });

    // Le payeur a debourse montant_charge (montant du + frais de transaction, voir FRAIS_PLATEFORME_FCFA) :
    // la difference est enregistree a part pour que la caisse montre clairement qu'elle couvre la
    // commission Jeko (1,5%) prelevee sur ce paiement, plutot que de la confondre avec la cotisation.
    const frais = Number(ligne.montant_charge) - Number(ligne.montant);
    if (frais > 0) {
      await enregistrerEntreeCaisse({
        membreId: ligne.membre_id,
        montant: frais,
        dateOperation: aujourdhui,
        saisiPar: ligne.membre_id,
        libelle: `Frais de transaction en ligne (compense la commission Jeko) - ${membre.prenom} ${membre.nom}`,
        categorie: 'Frais de transaction',
        paiementId: resultPaiement.insertId,
      });
    }

    await appliquerPaiementAuxCotisations(ligne.membre_id, moisCouverts, ligne.montant);
    await pool.query('UPDATE paiements_en_ligne SET paiement_id = ? WHERE id = ?', [resultPaiement.insertId, ligne.id]);

    await notifyUser(ligne.membre_id, {
      type: 'paiement_recu',
      titre: 'Paiement reçu',
      contenu: `Votre paiement de ${ligne.montant} FCFA via ${ligne.payment_method} a été confirmé.`,
      lien: '/cotisations/ma-fiche',
    });
    broadcast('cotisations:update');
    broadcast('caisse:update');
  } else {
    broadcast('cotisations:update');
  }
}

// Annule un paiement (saisie manuelle, declaration validee ou paiement en ligne) : le paiement
// et l'ecriture de caisse qu'il a generee sont marques 'annulee' (jamais supprimes, pour garder
// une trace), puis les lignes de cotisation des annees concernees sont recalculees depuis zero
// en rejouant tous les AUTRES paiements valides du membre -- fiable meme si plusieurs paiements
// se chevauchent sur les memes mois (contrairement a une simple soustraction du montant annule).
async function annulerPaiement(paiementId, annulePar) {
  const [[paiement]] = await pool.query('SELECT * FROM paiements WHERE id = ?', [paiementId]);
  if (!paiement) {
    const err = new Error('Paiement introuvable.');
    err.status = 404;
    throw err;
  }
  if (paiement.statut_validation === 'annulee') {
    const err = new Error('Ce paiement est déjà annulé.');
    err.status = 400;
    throw err;
  }

  const moisCouverts = typeof paiement.mois_couverts === 'string' ? JSON.parse(paiement.mois_couverts) : paiement.mois_couverts;
  const annees = [...new Set(moisCouverts.map((m) => m.annee))];

  await pool.query(`UPDATE paiements SET statut_validation = 'annulee' WHERE id = ?`, [paiementId]);
  await pool.query(`UPDATE caisse_operations SET statut = 'annulee' WHERE paiement_id = ? AND statut != 'annulee'`, [paiementId]);

  const [autresPaiements] = await pool.query(
    `SELECT * FROM paiements WHERE membre_id = ? AND statut_validation = 'valide' AND id != ? ORDER BY date_paiement ASC, id ASC`,
    [paiement.membre_id, paiementId]
  );

  for (const annee of annees) {
    await pool.query(
      `UPDATE cotisations SET montant_paye = 0, statut = IF(montant_du > 0, 'non_paye', 'non_du')
       WHERE membre_id = ? AND annee = ?`,
      [paiement.membre_id, annee]
    );

    for (const p of autresPaiements) {
      const mc = typeof p.mois_couverts === 'string' ? JSON.parse(p.mois_couverts) : p.mois_couverts;
      const mcAnnee = mc.filter((m) => m.annee === annee);
      if (mcAnnee.length) await appliquerPaiementAuxCotisations(paiement.membre_id, mcAnnee, p.montant);
    }
  }

  await logAudit({
    tableName: 'paiements',
    recordId: paiementId,
    userId: annulePar,
    action: 'annulation',
    ancienneValeur: { membre_id: paiement.membre_id, montant: paiement.montant, mois_couverts: moisCouverts },
  });

  broadcast('cotisations:update');
  broadcast('caisse:update');
}

module.exports = {
  enregistrerEntreeCaisse,
  libellePaiement,
  totalRestantDu,
  appliquerPaiementAuxCotisations,
  finaliserPaiementEnLigne,
  annulerPaiement,
};
