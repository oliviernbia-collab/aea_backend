-- Corrige une seule ecriture de caisse orpheline (id 42) : creee AVANT le deploiement de
-- l'annulation de paiement (paiement_id n'existait pas encore), elle n'a donc pas pu etre
-- retrouvee ni marquee "annulee" quand le paiement 29 correspondant a ete annule.
-- Toujours compte en 'validee' dans le solde alors que son paiement est annule -> 2000 FCFA
-- comptes a tort.
--
-- A executer UNE SEULE FOIS dans phpMyAdmin, sur la base de production.
-- Verifie d'abord que la ligne correspond bien (meme montant/date que le paiement 29) :
SELECT * FROM caisse_operations WHERE id = 42;
SELECT * FROM paiements WHERE id = 29;

-- Puis la correction :
UPDATE caisse_operations SET statut = 'annulee', paiement_id = 29 WHERE id = 42;

-- Verification qu'il n'y a pas d'autre cas similaire (paiement annule dont l'ecriture de
-- caisse, non reliee par paiement_id, est restee 'validee' a tort) : ne devrait renvoyer
-- aucune ligne desormais. Heuristique par membre/montant/date, a verifier a l'oeil.
SELECT p.id AS paiement_id, p.membre_id, p.montant, p.date_paiement, co.id AS caisse_id, co.statut
FROM paiements p
JOIN caisse_operations co
  ON co.montant = p.montant AND co.date_operation = p.date_paiement AND co.paiement_id IS NULL
WHERE p.statut_validation = 'annulee' AND co.statut = 'validee';
