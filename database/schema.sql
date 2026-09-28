-- Cahier des Charges CDC-AEA-2026-002 -- Schema version 1 (modules P1 + P2 de base)
CREATE DATABASE IF NOT EXISTS db_aea CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE db_aea;

-- ============================================================
-- 3. Membres et profils (RBAC)
-- ============================================================
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  numero_membre VARCHAR(20) UNIQUE NOT NULL,
  nom VARCHAR(100) NOT NULL,
  prenom VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  telephone VARCHAR(30) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  photo VARCHAR(255) NULL,
  filiere VARCHAR(100) NULL,
  niveau VARCHAR(50) NULL,
  promotion VARCHAR(50) NULL,
  role ENUM('super_admin','president','tresorier','secretaire_general','resp_communication','membre') NOT NULL DEFAULT 'membre',
  statut ENUM('en_attente','actif','inactif','suspendu','honoraire') NOT NULL DEFAULT 'en_attente',
  two_fa_enabled BOOLEAN NOT NULL DEFAULT 0,
  two_fa_secret VARCHAR(255) NULL,
  notif_preferences JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE password_resets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  used BOOLEAN NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 2 & 4.1 Caisse de l'association
-- ============================================================
CREATE TABLE caisse_operations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('entree','sortie') NOT NULL,
  fonds ENUM('fonctionnement','entraide','evenements') NOT NULL DEFAULT 'fonctionnement',
  categorie VARCHAR(100) NOT NULL,
  libelle VARCHAR(255) NOT NULL,
  montant DECIMAL(12,2) NOT NULL,
  date_operation DATE NOT NULL,
  justificatif VARCHAR(255) NULL,
  saisi_par INT NOT NULL,
  statut ENUM('validee','en_attente_validation','annulee') NOT NULL DEFAULT 'validee',
  valide_par INT NULL,
  operation_annulee_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (saisi_par) REFERENCES users(id),
  FOREIGN KEY (valide_par) REFERENCES users(id),
  FOREIGN KEY (operation_annulee_id) REFERENCES caisse_operations(id)
) ENGINE=InnoDB;

CREATE TABLE signalements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  membre_id INT NOT NULL,
  operation_id INT NULL,
  message TEXT NOT NULL,
  statut ENUM('ouvert','traite') NOT NULL DEFAULT 'ouvert',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (membre_id) REFERENCES users(id),
  FOREIGN KEY (operation_id) REFERENCES caisse_operations(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ============================================================
-- 4.2 Cotisations mensuelles
-- ============================================================
CREATE TABLE cotisations_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  annee INT NOT NULL UNIQUE,
  montant_membre DECIMAL(10,2) NOT NULL,
  montant_bureau DECIMAL(10,2) NOT NULL DEFAULT 1000,
  montant_adhesion DECIMAL(10,2) NOT NULL DEFAULT 1000,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE cotisations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  membre_id INT NOT NULL,
  annee INT NOT NULL,
  mois TINYINT NOT NULL COMMENT '0 = droit d''adhesion (paiement unique) ; 1-12 = cotisation mensuelle',
  montant_du DECIMAL(10,2) NOT NULL DEFAULT 0,
  montant_paye DECIMAL(10,2) NOT NULL DEFAULT 0,
  statut ENUM('non_du','non_paye','partiel','paye') NOT NULL DEFAULT 'non_paye',
  UNIQUE KEY uniq_membre_mois (membre_id, annee, mois),
  FOREIGN KEY (membre_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE paiements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  membre_id INT NOT NULL,
  montant DECIMAL(10,2) NOT NULL,
  date_paiement DATE NOT NULL,
  mode_paiement ENUM('especes','orange_money','mtn_momo','moov_money','wave') NOT NULL,
  mois_couverts JSON NOT NULL,
  preuve_capture VARCHAR(255) NULL,
  statut_validation ENUM('valide','en_attente') NOT NULL DEFAULT 'valide',
  recu_numero VARCHAR(50) NULL,
  saisi_par INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (membre_id) REFERENCES users(id),
  FOREIGN KEY (saisi_par) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============================================================
-- 4.3 Messagerie
-- ============================================================
CREATE TABLE messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  expediteur_id INT NOT NULL,
  destinataire_id INT NULL,
  scope ENUM('prive','broadcast','groupe') NOT NULL DEFAULT 'prive',
  groupe_cible VARCHAR(100) NULL,
  contenu TEXT NOT NULL,
  piece_jointe VARCHAR(255) NULL,
  signale BOOLEAN NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (expediteur_id) REFERENCES users(id),
  FOREIGN KEY (destinataire_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE message_reads (
  message_id INT NOT NULL,
  user_id INT NOT NULL,
  read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 4.4 Actualites et informations
-- ============================================================
CREATE TABLE actualites (
  id INT AUTO_INCREMENT PRIMARY KEY,
  titre VARCHAR(200) NOT NULL,
  texte TEXT NOT NULL,
  image VARCHAR(255) NULL,
  categorie ENUM('annonce_officielle','vie_academique','culture','social','opportunites') NOT NULL,
  auteur_id INT NOT NULL,
  epingle BOOLEAN NOT NULL DEFAULT 0,
  visibilite ENUM('publique','membres') NOT NULL DEFAULT 'membres',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (auteur_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ============================================================
-- 4.5 Notifications
-- ============================================================
CREATE TABLE notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  titre VARCHAR(150) NOT NULL,
  contenu TEXT NULL,
  lien VARCHAR(255) NULL,
  lu BOOLEAN NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ============================================================
-- 5.3 Journal inalterable (audit financier)
-- ============================================================
CREATE TABLE journal_audit (
  id INT AUTO_INCREMENT PRIMARY KEY,
  table_name VARCHAR(50) NOT NULL,
  record_id INT NOT NULL,
  user_id INT NOT NULL,
  action ENUM('creation','modification','annulation','validation') NOT NULL,
  ancienne_valeur JSON NULL,
  nouvelle_valeur JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE INDEX idx_cotisations_membre ON cotisations(membre_id);
CREATE INDEX idx_caisse_date ON caisse_operations(date_operation);
CREATE INDEX idx_messages_dest ON messages(destinataire_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, lu);
