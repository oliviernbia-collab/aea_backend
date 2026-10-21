-- Correction d'un paiement de cotisation mal saisi (ex. montant tape avec une erreur).
-- Il n'y a pas de bouton "modifier/annuler un paiement" dans l'application : un paiement
-- saisi touche 3 tables (paiements, cotisations, caisse_operations), donc la correction passe
-- par ce script. Strategie : annuler proprement l'ecriture erronee, puis RESAISIR le bon
-- montant normalement via Saisie financiere dans l'app (elle recalcule tout correctement).
--
-- A executer dans phpMyAdmin, UNE ETAPE A LA FOIS (ne pas tout lancer d'un bloc) :
-- 1) l'etape 0 sert a identifier les bonnes lignes (ids) a corriger
-- 2) les etapes 1-3 suppriment/reinitialisent ce qu'il faut, avec les ids trouves a l'etape 0
-- 3) tu ressaisis ensuite le bon montant dans l'app (Saisie financiere)


-- ============================================================
-- ETAPE 0 : identifier le paiement a corriger (remplace le numero de membre)
-- ============================================================
SET @numero_membre = 'AEA-2026-0004';  -- <-- change ici

SELECT p.id AS paiement_id, u.numero_membre, u.nom, u.prenom, p.montant, p.date_paiement,
       p.mode_paiement, p.mois_couverts, p.recu_numero
FROM paiements p
JOIN users u ON u.id = p.membre_id
WHERE u.numero_membre = @numero_membre
ORDER BY p.date_paiement DESC;

-- Note le paiement_id du paiement errone et le contenu de mois_couverts (ex. [{"annee":2026,"mois":3}])
-- -- c'est ce qu'il faut remettre a zero a l'etape 3.

-- Retrouve ensuite l'ecriture de caisse correspondante (meme montant, meme date, meme membre
-- dans le libelle) :
SELECT co.id AS operation_id, co.libelle, co.montant, co.date_operation, co.statut
FROM caisse_operations co
WHERE co.montant = (SELECT montant FROM paiements WHERE id = /* <-- paiement_id trouve ci-dessus */ 0)
  AND co.date_operation = (SELECT date_paiement FROM paiements WHERE id = /* <-- paiement_id */ 0)
ORDER BY co.id DESC;


-- ============================================================
-- ETAPE 1 : supprimer le paiement errone (remplace l'id trouve a l'etape 0)
-- ============================================================
SET @paiement_id = 0;  -- <-- change ici (paiement_id de l'etape 0)

DELETE FROM paiements WHERE id = @paiement_id;


-- ============================================================
-- ETAPE 2 : supprimer l'ecriture de caisse correspondante (remplace l'id trouve a l'etape 0)
-- ============================================================
SET @operation_id = 0;  -- <-- change ici (operation_id de l'etape 0)

DELETE FROM caisse_operations WHERE id = @operation_id;


-- ============================================================
-- ETAPE 3 : remettre a zero le(s) mois couvert(s) par ce paiement
-- (remplace numero de membre, annee et mois d'apres le mois_couverts note a l'etape 0 ;
--  ajoute un mois dans la liste IN (...) pour chaque mois couvert par le paiement)
-- ============================================================
UPDATE cotisations c
JOIN users u ON u.id = c.membre_id
SET c.montant_paye = 0,
    c.statut = IF(c.montant_du > 0, 'non_paye', 'non_du')
WHERE u.numero_membre = @numero_membre   -- <-- meme numero qu'a l'etape 0
  AND c.annee = 2026                      -- <-- change si besoin
  AND c.mois IN (3);                      -- <-- change : le(s) mois du mois_couverts errone

-- Ensuite : ressaisis le bon montant via Saisie financiere dans l'app (pas en SQL),
-- pour que paiements/cotisations/caisse_operations soient recrees correctement ensemble.
