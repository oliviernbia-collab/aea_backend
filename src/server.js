require('dotenv').config();

// Filet de securite : une erreur async non interceptee dans une route ne doit jamais faire
// tomber tout le serveur (et donc tous les utilisateurs connectes). On la journalise et on continue.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const app = require('./app');
const { setIo: setNotifyIo } = require('./utils/notify');
const { setIo: setMessagesIo } = require('./routes/messages.routes');
const { startScheduler } = require('./jobs/scheduler');

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN?.split(',') || '*' },
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentification requise.'));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = payload;
    next();
  } catch (err) {
    next(new Error('Token invalide.'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.user.id}`);
});

setNotifyIo(io);
setMessagesIo(io);
startScheduler();

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`API AEA demarree sur http://localhost:${PORT}`);
});
