-- Feature : bouton "Annuler un paiement" (super admin) sur la page Cotisations.
-- Necessaire pour que l'annulation retrouve et neutralise automatiquement l'ecriture
-- de caisse creee par un paiement (au lieu de la retrouver "a vue" par montant/date).
--
-- A executer UNE SEULE FOIS dans phpMyAdmin, sur la base de production, AVANT de deployer
-- le code backend qui utilise ces colonnes.

ALTER TABLE caisse_operations
  ADD COLUMN paiement_id INT NULL AFTER justificatif,
  ADD FOREIGN KEY (paiement_id) REFERENCES paiements(id);

ALTER TABLE paiements
  MODIFY COLUMN statut_validation ENUM('valide', 'en_attente', 'annulee') NOT NULL DEFAULT 'valide';
