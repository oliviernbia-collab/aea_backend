USE db_aea;

-- Compte administrateur initial (mot de passe: olivier1999 -- a changer apres la premiere connexion)
-- hash bcrypt genere pour "olivier1999"
INSERT INTO users (numero_membre, nom, prenom, email, telephone, password_hash, role, statut)
VALUES (
  'AEA-2026-0001',
  'Bureau',
  'Administrateur',
  'admin@aea.local',
  '+2250000000000',
  '$2a$10$TRz5L9irhXENLxYAGZDJj.vXLNuI2E0gJ0VjxUpMmXBQN5JWcdb96',
  'super_admin',
  'actif'
);

-- Bareme 2026 : 500 FCFA/mois pour un membre simple, 1000 FCFA/mois pour un role du bureau,
-- 1000 FCFA de droit d'adhesion unique pour tout nouveau membre.
INSERT INTO cotisations_config (annee, montant_membre, montant_bureau, montant_adhesion) VALUES (2026, 500.00, 1000.00, 1000.00);

INSERT INTO cotisations (membre_id, annee, mois, montant_du, montant_paye, statut)
VALUES (1, 2026, 0, 1000.00, 0, 'non_paye');
