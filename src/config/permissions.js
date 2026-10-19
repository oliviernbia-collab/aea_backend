// Postes titulaires du Bureau Executif National (BEN) : acces admin complet.
const BUREAU_ROLES = [
  'super_admin',
  'president',
  'vice_president',
  'secretaire_general',
  'tresorier',
  'resp_communication',
  'secretaire_organisation',
  'secretaire_academique',
  'secretaire_culturel',
  'commissaire_comptes',
  'secretaire_ideologique',
  'secretaire_social',
  'secretaire_insertion',
];

// Postes adjoints (A1/A2) : acces standard membre, mais titre dedie sur la carte/annuaire.
const ADJOINT_ROLES = [
  'sg_adjoint_1', 'sg_adjoint_2',
  'sf_adjoint_1', 'sf_adjoint_2',
  'com_adjoint_1', 'com_adjoint_2',
  'so_adjoint_1', 'so_adjoint_2',
  'saas_adjoint_1', 'saas_adjoint_2',
  'sacs_adjoint_1', 'sacs_adjoint_2',
  'cc_adjoint_1',
  'sfi_adjoint_1',
  'sase_adjoint_1', 'sase_adjoint_2',
  'sipe_adjoint_1', 'sipe_adjoint_2',
];

const ROLES = ['membre', ...BUREAU_ROLES, ...ADJOINT_ROLES];

// Libelles affiches dans les listes deroulantes et sur la carte de membre.
const ROLE_LABELS = {
  membre: 'Membre',
  super_admin: 'Super administrateur',
  president: 'Président(e)',
  vice_president: 'Vice-Président(e)',
  secretaire_general: 'Secrétaire Général(e)',
  tresorier: 'Secrétaire aux Finances',
  resp_communication: 'Secrétaire à la Communication',
  secretaire_organisation: "Secrétaire à l'Organisation",
  secretaire_academique: 'Secrétaire aux Affaires Académiques et Scolaires',
  secretaire_culturel: 'Secrétaire aux Affaires Culturelles et Sportives',
  commissaire_comptes: 'Commissaire aux Comptes',
  secretaire_ideologique: 'Secrétaire à la Formation Idéologique',
  secretaire_social: 'Secrétaire aux Affaires Sociales et à l\'Environnement',
  secretaire_insertion: "Secrétaire à l'Insertion Professionnelle et à l'Entrepreneuriat",
  sg_adjoint_1: 'Secrétaire Général Adjoint (1)',
  sg_adjoint_2: 'Secrétaire Général Adjoint (2)',
  sf_adjoint_1: 'Adjoint Secrétaire aux Finances (1)',
  sf_adjoint_2: 'Adjoint Secrétaire aux Finances (2)',
  com_adjoint_1: 'Adjoint Communication (1)',
  com_adjoint_2: 'Adjoint Communication (2)',
  so_adjoint_1: "Adjoint à l'Organisation (1)",
  so_adjoint_2: "Adjoint à l'Organisation (2)",
  saas_adjoint_1: 'Adjoint Affaires Académiques (1)',
  saas_adjoint_2: 'Adjoint Affaires Académiques (2)',
  sacs_adjoint_1: 'Adjoint Affaires Culturelles (1)',
  sacs_adjoint_2: 'Adjoint Affaires Culturelles (2)',
  cc_adjoint_1: 'Adjoint Commissaire aux Comptes',
  sfi_adjoint_1: 'Adjoint Formation Idéologique',
  sase_adjoint_1: 'Adjoint Affaires Sociales (1)',
  sase_adjoint_2: 'Adjoint Affaires Sociales (2)',
  sipe_adjoint_1: 'Adjoint Insertion Professionnelle (1)',
  sipe_adjoint_2: 'Adjoint Insertion Professionnelle (2)',
};

// Catalogue unique des permissions. Chaque entree reprend un point de controle
// deja en place dans les routes (authorize(...)) ou dans le routage frontend
// (ProtectedRoute roles=[...]), afin que la page de gestion des permissions
// pilote reellement ces verifications plutot que de simples cases cosmetiques.
const PERMISSIONS = [
  { key: 'membres.voir_en_attente', module: 'Membres', label: 'Voir les inscriptions en attente' },
  { key: 'membres.creer', module: 'Membres', label: 'Créer un membre' },
  { key: 'membres.changer_statut', module: 'Membres', label: "Valider/changer le statut d'un membre" },
  { key: 'membres.changer_role', module: 'Membres', label: "Changer le rôle d'un membre" },
  { key: 'membres.supprimer', module: 'Membres', label: 'Supprimer (anonymiser) un membre' },

  { key: 'cotisations.configurer', module: 'Cotisations', label: 'Configurer le barème des cotisations' },
  { key: 'cotisations.voir_adhesions', module: 'Cotisations', label: "Voir les droits d'adhésion de tous les membres" },
  { key: 'cotisations.saisir_paiement', module: 'Cotisations', label: 'Saisir un paiement' },
  { key: 'cotisations.valider_declaration', module: 'Cotisations', label: 'Valider une déclaration Mobile Money' },

  { key: 'caisse.saisir_operation', module: 'Caisse', label: 'Saisir une opération de caisse' },
  { key: 'caisse.valider_operation', module: 'Caisse', label: 'Valider une opération (double validation)' },
  { key: 'caisse.annuler_operation', module: 'Caisse', label: 'Annuler une opération' },

  { key: 'actualites.gerer', module: 'Actualites', label: 'Créer / modifier / supprimer une actualité' },
  { key: 'messages.diffuser', module: 'Messagerie', label: 'Diffuser un message au bureau ou à un groupe' },

  { key: 'administration.acceder', module: 'Administration', label: "Accéder à la page Administration" },
  { key: 'saisie_financiere.acceder', module: 'Administration', label: 'Accéder à la Saisie financière' },
  { key: 'journal.consulter', module: 'Administration', label: "Consulter le journal d'activité" },
  { key: 'permissions.gerer', module: 'Administration', label: 'Gérer les permissions des rôles' },
  { key: 'cartes.generer', module: 'Administration', label: 'Voir et générer les cartes de tous les membres' },
];

// Valeurs par defaut, identiques au comportement code en dur avant l'introduction
// de ce systeme : rien ne change pour les utilisateurs existants jusqu'a ce qu'un
// administrateur modifie explicitement un droit depuis l'interface.
const DEFAULTS = {
  'membres.voir_en_attente': ['secretaire_general', 'super_admin'],
  'membres.creer': ['super_admin', 'president', 'vice_president', 'secretaire_general'],
  'membres.changer_statut': ['secretaire_general', 'super_admin', 'president', 'vice_president'],
  'membres.changer_role': ['super_admin', 'president', 'vice_president'],
  'membres.supprimer': ['super_admin', 'secretaire_general'],

  'cotisations.configurer': ['tresorier', 'super_admin'],
  'cotisations.voir_adhesions': ['tresorier', 'president', 'vice_president', 'secretaire_general', 'super_admin'],
  'cotisations.saisir_paiement': ['tresorier', 'super_admin'],
  'cotisations.valider_declaration': ['tresorier', 'super_admin'],

  'caisse.saisir_operation': ['tresorier', 'super_admin'],
  'caisse.valider_operation': ['president', 'vice_president', 'super_admin'],
  'caisse.annuler_operation': ['tresorier', 'super_admin'],

  'actualites.gerer': BUREAU_ROLES,
  'messages.diffuser': BUREAU_ROLES,

  'administration.acceder': ['super_admin', 'president', 'vice_president', 'secretaire_general'],
  'saisie_financiere.acceder': ['tresorier', 'president', 'vice_president', 'super_admin'],
  'journal.consulter': BUREAU_ROLES,
  'permissions.gerer': ['super_admin'],
  'cartes.generer': ['super_admin'],
};

module.exports = { ROLES, BUREAU_ROLES, ADJOINT_ROLES, ROLE_LABELS, PERMISSIONS, DEFAULTS };
