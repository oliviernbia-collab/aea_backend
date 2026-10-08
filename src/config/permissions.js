const ROLES = ['membre', 'tresorier', 'secretaire_general', 'resp_communication', 'president', 'super_admin'];
const BUREAU_ROLES = ['super_admin', 'president', 'tresorier', 'secretaire_general', 'resp_communication'];

// Catalogue unique des permissions. Chaque entree reprend un point de controle
// deja en place dans les routes (authorize(...)) ou dans le routage frontend
// (ProtectedRoute roles=[...]), afin que la page de gestion des permissions
// pilote reellement ces verifications plutot que de simples cases cosmetiques.
const PERMISSIONS = [
  { key: 'membres.voir_en_attente', module: 'Membres', label: 'Voir les inscriptions en attente' },
  { key: 'membres.creer', module: 'Membres', label: 'Creer un membre' },
  { key: 'membres.changer_statut', module: 'Membres', label: "Valider/changer le statut d'un membre" },
  { key: 'membres.changer_role', module: 'Membres', label: "Changer le role d'un membre" },
  { key: 'membres.supprimer', module: 'Membres', label: 'Supprimer (anonymiser) un membre' },

  { key: 'cotisations.configurer', module: 'Cotisations', label: 'Configurer le bareme des cotisations' },
  { key: 'cotisations.voir_adhesions', module: 'Cotisations', label: "Voir les droits d'adhesion de tous les membres" },
  { key: 'cotisations.saisir_paiement', module: 'Cotisations', label: 'Saisir un paiement' },
  { key: 'cotisations.valider_declaration', module: 'Cotisations', label: 'Valider une declaration Mobile Money' },

  { key: 'caisse.saisir_operation', module: 'Caisse', label: 'Saisir une operation de caisse' },
  { key: 'caisse.valider_operation', module: 'Caisse', label: 'Valider une operation (double validation)' },
  { key: 'caisse.annuler_operation', module: 'Caisse', label: 'Annuler une operation' },

  { key: 'actualites.gerer', module: 'Actualites', label: 'Creer / modifier / supprimer une actualite' },
  { key: 'messages.diffuser', module: 'Messagerie', label: 'Diffuser un message au bureau ou a un groupe' },

  { key: 'administration.acceder', module: 'Administration', label: "Acceder a la page Administration" },
  { key: 'saisie_financiere.acceder', module: 'Administration', label: 'Acceder a la Saisie financiere' },
  { key: 'journal.consulter', module: 'Administration', label: "Consulter le journal d'activite" },
  { key: 'permissions.gerer', module: 'Administration', label: 'Gerer les permissions des roles' },
];

// Valeurs par defaut, identiques au comportement code en dur avant l'introduction
// de ce systeme : rien ne change pour les utilisateurs existants jusqu'a ce qu'un
// administrateur modifie explicitement un droit depuis l'interface.
const DEFAULTS = {
  'membres.voir_en_attente': ['secretaire_general', 'super_admin'],
  'membres.creer': ['super_admin', 'president', 'secretaire_general'],
  'membres.changer_statut': ['secretaire_general', 'super_admin', 'president'],
  'membres.changer_role': ['super_admin', 'president'],
  'membres.supprimer': ['super_admin', 'secretaire_general'],

  'cotisations.configurer': ['tresorier', 'super_admin'],
  'cotisations.voir_adhesions': ['tresorier', 'president', 'secretaire_general', 'super_admin'],
  'cotisations.saisir_paiement': ['tresorier', 'super_admin'],
  'cotisations.valider_declaration': ['tresorier', 'super_admin'],

  'caisse.saisir_operation': ['tresorier', 'super_admin'],
  'caisse.valider_operation': ['president', 'super_admin'],
  'caisse.annuler_operation': ['tresorier', 'super_admin'],

  'actualites.gerer': BUREAU_ROLES,
  'messages.diffuser': BUREAU_ROLES,

  'administration.acceder': ['super_admin', 'president', 'secretaire_general'],
  'saisie_financiere.acceder': ['tresorier', 'president', 'super_admin'],
  'journal.consulter': BUREAU_ROLES,
  'permissions.gerer': ['super_admin'],
};

module.exports = { ROLES, BUREAU_ROLES, PERMISSIONS, DEFAULTS };
