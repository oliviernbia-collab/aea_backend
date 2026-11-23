const pool = require('../config/db');
const { broadcast } = require('../utils/notify');

// Tarifs des documents vendus en ligne depuis la page d'accueil (en FCFA). Le backend est la
// seule source de verite du prix : le montant envoye par le navigateur n'est jamais utilise.
const TARIFS_DOCUMENTS = { cv: 300, carte_visite: 200 };

// Conclut une commande de document apres retour de Jeko (webhook ou polling de secours).
// Idempotent, sur le meme principe que finaliserPaiementEnLigne : seule l'UPDATE qui trouve
// encore la ligne en 'pending' est prise en compte (pas de double comptage de la vente).
async function finaliserCommandeDocument(id, transactionJeko) {
  if (!transactionJeko || transactionJeko.status === 'pending') return;

  const nouveauStatut = transactionJeko.status === 'success' ? 'success' : 'error';
  const [reclamation] = await pool.query(
    `UPDATE commandes_documents
     SET statut = ?, error_reason = ?, paye_le = IF(? = 'success', NOW(), NULL)
     WHERE id = ? AND statut = 'pending'`,
    [nouveauStatut, nouveauStatut === 'error' ? (transactionJeko.errorReason || 'echec_operateur') : null, nouveauStatut, id]
  );
  if (!reclamation.affectedRows) return;
  // Les ventes NE PASSENT PAS par la caisse de l'association (visible par tous les membres) :
  // elles restent dans commandes_documents et ne sont consultables que par le super administrateur
  // (Administration > Ventes CV / cartes, via GET /api/documents/ventes).
  if (nouveauStatut === 'success') broadcast('documents:ventes');
}

module.exports = { TARIFS_DOCUMENTS, finaliserCommandeDocument };
