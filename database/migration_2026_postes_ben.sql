-- Migration : ajout de tous les postes du Bureau Executif National (mandat 2026-2028)
-- A executer une seule fois sur la base de donnees existante (phpMyAdmin ou mysql CLI).
-- Les membres actuels conservent leur role ; seules de nouvelles valeurs deviennent disponibles.

USE db_aea;

ALTER TABLE users
  MODIFY COLUMN role ENUM(
    'membre','super_admin','president','vice_president','secretaire_general','tresorier','resp_communication',
    'secretaire_organisation','secretaire_academique','secretaire_culturel','commissaire_comptes',
    'secretaire_ideologique','secretaire_social','secretaire_insertion',
    'sg_adjoint_1','sg_adjoint_2','sf_adjoint_1','sf_adjoint_2','com_adjoint_1','com_adjoint_2',
    'so_adjoint_1','so_adjoint_2','saas_adjoint_1','saas_adjoint_2','sacs_adjoint_1','sacs_adjoint_2',
    'cc_adjoint_1','sfi_adjoint_1','sase_adjoint_1','sase_adjoint_2','sipe_adjoint_1','sipe_adjoint_2'
  ) NOT NULL DEFAULT 'membre';
