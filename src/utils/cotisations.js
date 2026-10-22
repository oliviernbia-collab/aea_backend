const pool = require('../config/db');
const { BUREAU_ROLES, ADJOINT_ROLES } = require('../config/permissions');

// Postes factures au tarif "bureau" (montant_bureau) : titulaires ET adjoints paient le meme
// tarif, distinct du tarif "membre simple" (montant_membre) applique a tous les autres membres.
const ROLES_TARIF_BUREAU = [...BUREAU_ROLES, ...ADJOINT_ROLES];

// 0 = droit d'adhesion (paiement unique a l'entree dans l'association) ; 1-12 = cotisation mensuelle
const MOIS_ADHESION = 0;

// Jeko facture 1,5% de commission sur chaque paiement en ligne. Pour que l'AEA recoive malgre tout
// le montant du complet (et une petite marge), ce surcout fixe est ajoute au montant demande au payeur,
// plutot que d'etre retranche de ce que touche l'association.
const FRAIS_PLATEFORME_FCFA = 100;

function statutDe(montantDu, montantPaye) {
  if (montantDu <= 0) return 'non_du';
  if (montantPaye <= 0) return 'non_paye';
  if (montantPaye < montantDu) return 'partiel';
  return 'paye';
}

// Montant du pour une ligne donnee : le droit d'adhesion est le meme pour tous, la cotisation
// mensuelle depend du role (membre simple vs role du bureau), selon le bareme de l'annee.
async function montantDuPour(membreId, annee, mois) {
  if (mois === MOIS_ADHESION) {
    const [config] = await pool.query('SELECT montant_adhesion FROM cotisations_config WHERE annee = ?', [annee]);
    return config.length ? Number(config[0].montant_adhesion) : 1000;
  }

  const [[membre]] = await pool.query('SELECT role FROM users WHERE id = ?', [membreId]);
  const [config] = await pool.query('SELECT montant_membre, montant_bureau FROM cotisations_config WHERE annee = ?', [
    annee,
  ]);
  if (!config.length) return 0;
  const estBureau = membre && ROLES_TARIF_BUREAU.includes(membre.role);
  return Number(estBureau ? config[0].montant_bureau : config[0].montant_membre);
}

// Recupere la ligne de cotisation (ou de droit d'adhesion) membre x mois, ou la cree si elle manque
// (ex. membre inscrit apres la configuration annuelle, ou configuration saisie hors du flux normal).
async function assurerLigneCotisation(membreId, annee, mois) {
  const [rows] = await pool.query('SELECT * FROM cotisations WHERE membre_id = ? AND annee = ? AND mois = ?', [
    membreId,
    annee,
    mois,
  ]);
  if (rows.length) return rows[0];

  const montantDu = await montantDuPour(membreId, annee, mois);
  const [result] = await pool.query(
    `INSERT INTO cotisations (membre_id, annee, mois, montant_du, montant_paye, statut) VALUES (?, ?, ?, ?, 0, 'non_paye')`,
    [membreId, annee, mois, montantDu]
  );
  return { id: result.insertId, membre_id: membreId, annee, mois, montant_du: montantDu, montant_paye: 0 };
}

// Cree, pour UN membre, les 12 lignes de cotisation mensuelle + la ligne de droit d'adhesion
// d'une annee donnee, selon le bareme en vigueur (cotisations_config). Meme logique que la
// boucle de POST /cotisations/config, mais appliquee a un seul membre (ex. a son activation) :
// sans ca, un membre active entre deux configurations n'a de ligne que pour les mois ou il a
// explicitement tente un paiement (assurerLigneCotisation est lazy), et les mois jamais "crees"
// n'apparaissent pas du tout dans le tableau de recouvrement -> il semble "a jour" a tort.
// Ne fait rien si aucun bareme n'a encore ete configure pour cette annee (rien a initialiser).
async function assurerLignesAnnee(membreId, annee) {
  const [config] = await pool.query('SELECT * FROM cotisations_config WHERE annee = ?', [annee]);
  if (!config.length) return;
  const { montant_membre, montant_bureau, montant_adhesion } = config[0];

  const [[membre]] = await pool.query('SELECT role FROM users WHERE id = ?', [membreId]);
  if (!membre) return;
  const montantMensuel = ROLES_TARIF_BUREAU.includes(membre.role) ? montant_bureau : montant_membre;

  for (let mois = 1; mois <= 12; mois += 1) {
    await pool.query(
      `INSERT INTO cotisations (membre_id, annee, mois, montant_du, montant_paye, statut)
       VALUES (?, ?, ?, ?, 0, ?)
       ON DUPLICATE KEY UPDATE
         montant_du = IF(montant_paye = 0, VALUES(montant_du), montant_du),
         statut = IF(montant_paye = 0, VALUES(statut), statut)`,
      [membreId, annee, mois, montantMensuel, montantMensuel > 0 ? 'non_paye' : 'non_du']
    );
  }
  await pool.query(
    `INSERT INTO cotisations (membre_id, annee, mois, montant_du, montant_paye, statut)
     VALUES (?, ?, ?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE
       montant_du = IF(montant_paye = 0, VALUES(montant_du), montant_du),
       statut = IF(montant_paye = 0, VALUES(statut), statut)`,
    [membreId, annee, MOIS_ADHESION, montant_adhesion, montant_adhesion > 0 ? 'non_paye' : 'non_du']
  );
}

module.exports = {
  MOIS_ADHESION,
  FRAIS_PLATEFORME_FCFA,
  statutDe,
  montantDuPour,
  assurerLigneCotisation,
  assurerLignesAnnee,
};
