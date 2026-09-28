const pool = require('../config/db');

async function genererNumeroMembre() {
  const annee = new Date().getFullYear();
  const [rows] = await pool.query(
    `SELECT numero_membre FROM users WHERE numero_membre LIKE ? ORDER BY id DESC LIMIT 1`,
    [`AEA-${annee}-%`]
  );
  let prochain = 1;
  if (rows.length) {
    const dernier = rows[0].numero_membre.split('-')[2];
    prochain = parseInt(dernier, 10) + 1;
  }
  return `AEA-${annee}-${String(prochain).padStart(4, '0')}`;
}

module.exports = { genererNumeroMembre };
