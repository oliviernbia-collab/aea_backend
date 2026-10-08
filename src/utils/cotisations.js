const pool = require('../config/db');

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

const ROLES_BUREAU = ['tresorier', 'secretaire_general', 'resp_communication', 'president', 'super_admin'];

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
  const estBureau = membre && ROLES_BUREAU.includes(membre.role);
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

module.exports = { MOIS_ADHESION, ROLES_BUREAU, FRAIS_PLATEFORME_FCFA, statutDe, montantDuPour, assurerLigneCotisation };
