const crypto = require('crypto');

// Client pour l'agregateur de paiement Jeko (https://business.jeko.africa).
// Doc integree via le serveur MCP jeko : encaissement direct fournisseur (API direct),
// qui pousse le payeur chez son operateur (Wave/Orange redirect, MTN/Moov push USSD)
// au lieu de passer par la page hebergee Jeko.

function estConfigure() {
  return !!(process.env.JEKO_API_KEY && process.env.JEKO_API_KEY_ID && process.env.JEKO_STORE_ID);
}

function headers() {
  return {
    'X-API-KEY': process.env.JEKO_API_KEY,
    'X-API-KEY-ID': process.env.JEKO_API_KEY_ID,
    'Content-Type': 'application/json',
  };
}

async function appelerJeko(path, options) {
  const base = process.env.JEKO_BASE_URL || 'https://api.jeko.africa';
  const res = await fetch(`${base}${path}`, { ...options, headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Les erreurs 422 observees en pratique arrivent sous la forme { errors: [...] },
    // pas sous la forme { id, message, extras } documentee pour les autres statuts.
    const detail = data.message
      || (Array.isArray(data.errors) ? data.errors.map((e) => e.message || `${e.field}: ${e.rule}`).join(' ; ') : null)
      || `Erreur Jeko (${res.status})`;
    const err = new Error(detail);
    err.jekoId = data.id;
    err.status = res.status;
    err.extras = data.extras || data.errors;
    throw err;
  }
  return data;
}

// Cree une demande de paiement en mode API direct (forceProviderDirect) : sur Wave/Orange,
// redirectUrl mene directement chez l'operateur ; sur MTN/Moov, l'operateur pousse un code USSD
// sur payerPhone et redirectUrl retombe sur la page d'attente hebergee par Jeko.
async function creerDemandePaiement({ amountCents, reference, paymentMethod, payerPhone, successUrl, errorUrl }) {
  return appelerJeko('/partner_api/payment_requests', {
    method: 'POST',
    body: JSON.stringify({
      storeId: process.env.JEKO_STORE_ID,
      amountCents,
      currency: 'XOF',
      reference,
      paymentDetails: {
        type: 'redirect',
        data: { paymentMethod, forceProviderDirect: true, payerPhone, successUrl, errorUrl },
      },
    }),
  });
}

async function recupererDemandePaiement(paymentRequestId) {
  return appelerJeko(`/partner_api/payment_requests/${paymentRequestId}`, { method: 'GET' });
}

// Signature HMAC-SHA256 du corps brut, en hexadecimal minuscule, comparee a temps constant.
function verifierSignature(rawBody, signatureRecue) {
  if (!signatureRecue || !process.env.JEKO_WEBHOOK_SECRET) return false;
  const attendue = crypto.createHmac('sha256', process.env.JEKO_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const recuBuf = Buffer.from(signatureRecue);
  const attendueBuf = Buffer.from(attendue);
  if (recuBuf.length !== attendueBuf.length) return false;
  return crypto.timingSafeEqual(recuBuf, attendueBuf);
}

// Numero mobile ivoirien au format exige par Jeko : +225 suivi de 01, 05 ou 07 puis 8 chiffres.
function normaliserTelephoneCI(brut) {
  if (!brut) return null;
  let v = String(brut).replace(/[^\d+]/g, '');
  if (v.startsWith('+')) v = v.slice(1);
  if (!v.startsWith('225')) {
    if (!v.startsWith('0')) return null;
    v = `225${v}`;
  }
  return /^225(01|05|07)\d{8}$/.test(v) ? `+${v}` : null;
}

module.exports = {
  estConfigure,
  creerDemandePaiement,
  recupererDemandePaiement,
  verifierSignature,
  normaliserTelephoneCI,
};
