const pool = require('../config/db');

let ioInstance = null;
function setIo(io) {
  ioInstance = io;
}

async function notifyUser(userId, { type, titre, contenu = null, lien = null }) {
  const [result] = await pool.query(
    `INSERT INTO notifications (user_id, type, titre, contenu, lien) VALUES (?, ?, ?, ?, ?)`,
    [userId, type, titre, contenu, lien]
  );
  const notification = { id: result.insertId, user_id: userId, type, titre, contenu, lien, lu: false };
  if (ioInstance) {
    ioInstance.to(`user:${userId}`).emit('notification', notification);
  }
  return notification;
}

async function notifyUsers(userIds, payload) {
  await Promise.all(userIds.map((id) => notifyUser(id, payload)));
}

// Diffuse un evenement de mise a jour a tous les clients connectes, pour que les pages
// (caisse, cotisations, membres, actualites...) se rafraichissent automatiquement en temps reel.
function broadcast(event, payload = {}) {
  if (ioInstance) {
    ioInstance.emit(event, payload);
  }
}

module.exports = { setIo, notifyUser, notifyUsers, broadcast };
