-- Change le bareme de cotisation mensuelle 2026 : membre = 500 FCFA, bureau = 1000 FCFA
-- (le droit d'adhesion n'est pas touche). Meme garde-fou que POST /cotisations/config et
-- assurerLignesAnnee() (backend/src/utils/cotisations.js) : une ligne deja (partiellement)
-- payee n'est jamais modifiee retroactivement.
--
-- A executer dans phpMyAdmin, sur la base selectionnee.

SET @annee = 2026;
SET @montant_membre = 500;
SET @montant_bureau = 1000;

-- 1) Nouveau bareme de reference pour les cotisations creees ensuite (nouveaux membres,
--    nouveaux mois...).
UPDATE cotisations_config
SET montant_membre = @montant_membre, montant_bureau = @montant_bureau
WHERE annee = @annee;

-- 2) Applique le nouveau bareme aux mois deja en base (1 a 12, hors droit d'adhesion)
--    qui ne sont pas encore payes.
UPDATE cotisations c
JOIN users u ON u.id = c.membre_id
SET
  c.montant_du = IF(
    u.role IN ('tresorier', 'secretaire_general', 'resp_communication', 'president', 'super_admin'),
    @montant_bureau,
    @montant_membre
  ),
  c.statut = 'non_paye'
WHERE c.annee = @annee
  AND c.mois BETWEEN 1 AND 12
  AND c.montant_paye = 0;
