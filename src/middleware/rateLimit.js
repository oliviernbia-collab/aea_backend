const rateLimit = require('express-rate-limit');

// Limite generale de l'API : evite les abus grossiers tout en restant large pour un usage normal
// (plusieurs onglets, rafraichissements temps reel, etc.).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de requêtes. Réessayez dans quelques minutes.' },
});

// Limite stricte sur les tentatives de connexion/inscription/reinitialisation de mot de passe
// (5.3 du CDC : "protection contre... les tentatives de connexion repetees").
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: 'Trop de tentatives. Réessayez dans quelques minutes.' },
});

module.exports = { apiLimiter, authLimiter };
