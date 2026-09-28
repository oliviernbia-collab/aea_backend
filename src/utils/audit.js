const pool = require('../config/db');

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
}

module.exports = { logAudit };
