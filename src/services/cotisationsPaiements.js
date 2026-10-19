const pool = require('../config/db');
const { logAudit } = require('../utils/audit');
const { notifyUser, broadcast } = require('../utils/notify');
const { MOIS_ADHESION, statutDe, assurerLigneCotisation } = require('../utils/cotisations');

// Fait entrer un paiement de cotisation valide dans la caisse de l'association (transparence financiere, section 2 du CDC)
async function enregistrerEntreeCaisse({ membreId, montant, dateOperation, saisiPar, libelle, categorie = 'Cotisation' }) {
  const [result] = await pool.query(
    `INSERT INTO caisse_operations (type, fonds, categorie, libelle, montant, date_operation, saisi_par, statut)
     VALUES ('entree', 'fonctionnement', ?, ?, ?, ?, ?, 'validee')`,
    [categorie, libelle, montant, dateOperation, saisiPar]
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

module.exports = {
  enregistrerEntreeCaisse,
  libellePaiement,
  appliquerPaiementAuxCotisations,
  finaliserPaiementEnLigne,
};
