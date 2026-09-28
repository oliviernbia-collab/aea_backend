function requireActif(req, res, next) {
  if (req.user.statut !== 'actif') {
    return res.status(403).json({ message: "Votre compte n'est pas actif : acces restreint." });
  }
  next();
}

module.exports = requireActif;
