const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentification requise.' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Session invalide ou expiree.' });
  }
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Vous n'avez pas les droits pour cette action." });
    }
    next();
  };
}

const BUREAU_ROLES = ['super_admin', 'president', 'tresorier', 'secretaire_general', 'resp_communication'];

module.exports = { authenticate, authorize, BUREAU_ROLES };
