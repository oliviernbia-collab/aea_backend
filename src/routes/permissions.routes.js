const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { requirePermission, getPermissionsMap, invalidatePermissionsCache } = require('../middleware/permissions');
const { ROLES, PERMISSIONS } = require('../config/permissions');
const { logAudit } = require('../utils/audit');
const { broadcast } = require('../utils/notify');

const router = express.Router();

// GET /api/permissions/mine -- droits effectifs de l'utilisateur connecte (pour la sidebar / le routage)
router.get('/mine', authenticate, async (req, res) => {
  if (req.user.role === 'super_admin') {
    const toutAutorise = Object.fromEntries(PERMISSIONS.map((p) => [p.key, true]));
    return res.json({ role: req.user.role, permissions: toutAutorise });
  }
  const map = await getPermissionsMap();
  const permissions = Object.fromEntries(PERMISSIONS.map((p) => [p.key, !!map[p.key]?.[req.user.role]]));
  res.json({ role: req.user.role, permissions });
});

// GET /api/permissions -- matrice complete (catalogue x roles) pour la page de gestion
router.get('/', authenticate, requirePermission('permissions.gerer'), async (req, res) => {
  const map = await getPermissionsMap();
  const matrice = PERMISSIONS.map((p) => ({
    key: p.key,
    module: p.module,
    label: p.label,
    roles: Object.fromEntries(ROLES.map((role) => [role, role === 'super_admin' ? true : !!map[p.key]?.[role]])),
  }));
  res.json({ roles: ROLES, permissions: matrice });
});

// PUT /api/permissions -- bascule un droit (role x cle) pour les roles autres que super_admin (toujours autorise)
router.put('/', authenticate, requirePermission('permissions.gerer'), async (req, res) => {
  const { role, key, autorise } = req.body;
  if (!ROLES.includes(role) || role === 'super_admin') {
    return res.status(400).json({ message: 'Rôle invalide.' });
  }
  if (!PERMISSIONS.some((p) => p.key === key)) {
    return res.status(400).json({ message: 'Permission inconnue.' });
  }

  await pool.query(
    `INSERT INTO role_permissions (role, permission_key, autorise) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE autorise = VALUES(autorise)`,
    [role, key, autorise ? 1 : 0]
  );
  invalidatePermissionsCache();

  await logAudit({
    tableName: 'role_permissions',
    recordId: 0,
    userId: req.user.id,
    action: 'modification',
    nouvelleValeur: { role, key, autorise: !!autorise },
  });

  broadcast('permissions:update');
  res.json({ message: 'Droit mis à jour.' });
});

module.exports = router;
