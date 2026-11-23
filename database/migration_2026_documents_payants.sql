-- Feature : vente en ligne de CV (300 FCFA) et de cartes de visite (200 FCFA) depuis la page
-- d'accueil publique, payes via Jeko, puis telechargeables en PDF.
--
-- A executer UNE SEULE FOIS dans phpMyAdmin, sur la base de production, AVANT de deployer
-- le code backend qui utilise cette table (migration purement additive, sans risque).

CREATE TABLE IF NOT EXISTS commandes_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(100) NOT NULL UNIQUE,
  -- Jeton secret remis uniquement a l'acheteur : sans lui, impossible de relire le contenu
  -- d'une commande (donnees personnelles du CV) ni de le telecharger.
  acces_token CHAR(64) NOT NULL,
  type ENUM('cv','carte_visite') NOT NULL,
  modele VARCHAR(50) NOT NULL,
  donnees JSON NOT NULL,
  montant DECIMAL(10,2) NOT NULL,
  payment_method ENUM('wave','orange','mtn','moov') NOT NULL,
  payer_phone VARCHAR(20) NOT NULL,
  jeko_payment_request_id VARCHAR(100) NULL,
  redirect_url VARCHAR(500) NULL,
  statut ENUM('pending','success','error') NOT NULL DEFAULT 'pending',
  error_reason VARCHAR(255) NULL,
  paye_le TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
