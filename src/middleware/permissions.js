const pool = require('../config/db');
const { ROLES, PERMISSIONS, DEFAULTS } = require('../config/permissions');

const CACHE_TTL_MS = 30000;
let cache = null;
let cacheAt = 0;

async function chargerMatrice() {
  const [rows] = await pool.query('SELECT role, permission_key, autorise FROM role_permissions');
  const map = {};
  for (const r of rows) {
    map[r.permission_key] ??= {};
    map[r.permission_key][r.role] = !!r.autorise;
  }
  return map;
}

async function getPermissionsMap() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  cache = await chargerMatrice();
  cacheAt = Date.now();
  return cache;
}

function invalidatePermissionsCache() {
  cache = null;
}

// Insere les droits par defaut pour toute cle/role qui n'a pas encore de ligne en base
// (ex. nouvelle permission ajoutee au catalogue). Idempotent, a appeler au demarrage.
async function ensureDefaultPermissions() {
  const values = [];
  for (const { key } of PERMISSIONS) {
    const rolesAutorises = DEFAULTS[key] || [];
    for (const role of ROLES) {
      values.push([role, key, rolesAutorises.includes(role) ? 1 : 0]);
    }
  }
  if (!values.length) return;
  await pool.query(
    `INSERT IGNORE INTO role_permissions (role, permission_key, autorise) VALUES ${values.map(() => '(?, ?, ?)').join(', ')}`,
    values.flat()
  );
  invalidatePermissionsCache();
}

// super_admin garde toujours tous les droits : filet de securite pour eviter
// qu'une erreur de manipulation sur la page de gestion ne verrouille l'application.
function requirePermission(key) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Authentification requise.' });
    if (req.user.role === 'super_admin') return next();
    try {
      const map = await getPermissionsMap();
      if (!map[key]?.[req.user.role]) {
        return res.status(403).json({ message: "Vous n'avez pas les droits pour cette action." });
      }
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Erreur lors de la verification des droits.' });
    }
  };
}

async function hasPermission(role, key) {
  if (role === 'super_admin') return true;
  const map = await getPermissionsMap();
  return !!map[key]?.[role];
}

module.exports = {
  requirePermission,
  hasPermission,
  getPermissionsMap,
  invalidatePermissionsCache,
  ensureDefaultPermissions,
};
