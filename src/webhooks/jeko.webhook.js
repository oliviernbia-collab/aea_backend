const express = require('express');
const pool = require('../config/db');
const jeko = require('../services/jeko');
const { finaliserPaiementEnLigne } = require('../services/cotisationsPaiements');

// Monte le webhook Jeko directement sur `app`, AVANT `express.json()` : la signature HMAC porte
// sur le corps brut (raw body), donc ce chemin doit rester en dehors du parseur JSON global.
// Voir jeko://docs/webhooks/integration (verification de signature) et /best-practices (idempotence).
function monterWebhookJeko(app) {
  app.post('/api/webhooks/jeko', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['jeko-signature'];
    if (!jeko.verifierSignature(req.body, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.headers['jeko-event'];
    let payload;
    try {
      payload = JSON.parse(req.body.toString());
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    // Accuser reception avant de traiter : le delai d'attente de Jeko est de 30s.
    res.status(200).json({ received: true });

    try {
      // TRANSACTION_COMPLETED est un corps plat (pas d'enveloppe). Les autres evenements
      // (SERVICE_PROVIDER_LINK_REQUEST, escrow) ne concernent pas l'encaissement des cotisations.
      if (event === 'SERVICE_PROVIDER_LINK_REQUEST' || payload.event) return;
      if (payload.transactionType !== 'payment') return;

      const reference = payload.transactionDetails?.reference;
      if (!reference) return;

      const [rows] = await pool.query('SELECT id FROM paiements_en_ligne WHERE reference = ?', [reference]);
      if (!rows.length) return; // paiement non lie a une tentative connue (hors perimetre cotisations)

      await finaliserPaiementEnLigne(rows[0].id, payload);
    } catch (err) {
      // Le 200 est deja parti : on journalise seulement, Jeko ne rejouera pas sur un 500 ici.
      console.error('[jeko webhook] traitement echoue', err);
    }
  });
}

module.exports = { monterWebhookJeko };
