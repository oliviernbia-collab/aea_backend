-- Rattrapage ponctuel : cree les lignes de cotisation manquantes (12 mois + droit d'adhesion)
-- pour tous les membres actifs de l'annee @annee, selon le bareme deja enregistre dans
-- cotisations_config. Reproduit exactement assurerLignesAnnee() (backend/src/utils/cotisations.js),
-- appelee normalement a l'activation d'un membre ou a l'enregistrement du bareme (POST /cotisations/config).
--
-- A executer dans phpMyAdmin, sur la base selectionnee. Idempotent (peut etre relance sans risque) :
-- ne modifie jamais une ligne deja payee ou partiellement payee (montant_paye > 0).

SET @annee = 2026;

INSERT INTO cotisations (membre_id, annee, mois, montant_du, montant_paye, statut)
SELECT
  u.id,
  @annee,
  m.mois,
  CASE
    WHEN m.mois = 0 THEN cc.montant_adhesion
    WHEN u.role IN ('tresorier', 'secretaire_general', 'resp_communication', 'president', 'super_admin') THEN cc.montant_bureau
    ELSE cc.montant_membre
  END AS montant_du,
  0,
  CASE
    WHEN (CASE
            WHEN m.mois = 0 THEN cc.montant_adhesion
            WHEN u.role IN ('tresorier', 'secretaire_general', 'resp_communication', 'president', 'super_admin') THEN cc.montant_bureau
            ELSE cc.montant_membre
          END) > 0 THEN 'non_paye'
    ELSE 'non_du'
  END AS statut
FROM (SELECT id, role FROM users WHERE statut = 'actif') u
JOIN cotisations_config cc ON cc.annee = @annee
-- "JOIN ... ON 1 = 1" plutot que CROSS JOIN : certaines versions de MySQL/MariaDB
-- confondent sinon ce JOIN sans condition avec le ON DUPLICATE KEY UPDATE plus loin.
JOIN (
  SELECT 0 AS mois UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
  UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8
  UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
) m ON 1 = 1
ON DUPLICATE KEY UPDATE
  montant_du = IF(montant_paye = 0, VALUES(montant_du), montant_du),
  statut = IF(montant_paye = 0, VALUES(statut), statut);
