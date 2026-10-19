const cron = require('node-cron');
const pool = require('../config/db');
const { notifyUsers } = require('../utils/notify');

// CAI: releve mensuel publie automatiquement le 5 de chaque mois
function publierReleveMensuel() {
  cron.schedule('0 8 5 * *', async () => {
    try {
      const [[solde]] = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN type='entree' THEN montant ELSE -montant END),0) AS solde
         FROM caisse_operations WHERE statut = 'validee'`
      );
      const [admin] = await pool.query(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
      const auteurId = admin[0]?.id;
      if (!auteurId) return;

      const moisLabel = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      await pool.query(
        `INSERT INTO actualites (titre, texte, categorie, auteur_id, visibilite)
         VALUES (?, ?, 'annonce_officielle', ?, 'membres')`,
        [`Releve mensuel de la caisse - ${moisLabel}`, `Solde actuel de la caisse : ${solde} FCFA.`, auteurId]
      );

      const [membres] = await pool.query(`SELECT id FROM users WHERE statut = 'actif'`);
      await notifyUsers(membres.map((m) => m.id), {
        type: 'releve_mensuel',
        titre: 'Relevé mensuel de la caisse disponible',
        lien: '/actualites',
      });
    } catch (err) {
      console.error('Erreur publication releve mensuel:', err);
    }
  });
}

// COT-07: relance automatique le 10 du mois aux membres non a jour
function relancerCotisations() {
  cron.schedule('0 9 10 * *', async () => {
    try {
      const annee = new Date().getFullYear();
      const mois = new Date().getMonth() + 1;
      const [retard] = await pool.query(
        `SELECT membre_id FROM cotisations WHERE annee = ? AND mois = ? AND statut IN ('non_paye','partiel')`,
        [annee, mois]
      );
      await notifyUsers(retard.map((r) => r.membre_id), {
        type: 'relance_cotisation',
        titre: 'Rappel : cotisation du mois non réglée',
        contenu: 'Merci de régulariser votre cotisation auprès du trésorier.',
        lien: '/cotisations/ma-fiche',
      });
    } catch (err) {
      console.error('Erreur relance cotisations:', err);
    }
  });
}

function startScheduler() {
  publierReleveMensuel();
  relancerCotisations();
}

module.exports = { startScheduler };
