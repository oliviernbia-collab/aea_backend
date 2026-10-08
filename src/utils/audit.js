const pool = require('../config/db');
const { broadcast } = require('./notify');

async function logAudit({ tableName, recordId, userId, action, ancienneValeur = null, nouvelleValeur = null }) {
  await pool.query(
    `INSERT INTO journal_audit (table_name, record_id, user_id, action, ancienne_valeur, nouvelle_valeur)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      tableName,
      recordId,
      userId,
      action,
      ancienneValeur ? JSON.stringify(ancienneValeur) : null,
      nouvelleValeur ? JSON.stringify(nouvelleValeur) : null,
    ]
  );
  broadcast('journal:update');
}

module.exports = { logAudit };
