const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config();

const { apiLimiter, authLimiter } = require('./middleware/rateLimit');
const authRoutes = require('./routes/auth.routes');
const membersRoutes = require('./routes/members.routes');
const caisseRoutes = require('./routes/caisse.routes');
const cotisationsRoutes = require('./routes/cotisations.routes');
const { router: messagesRoutes } = require('./routes/messages.routes');
const actualitesRoutes = require('./routes/actualites.routes');
const notificationsRoutes = require('./routes/notifications.routes');

const app = express();

app.use(
  helmet({
    // API pure (pas de pages HTML rendues ici) : CSP par defaut inutile et risque de gener
    // le chargement des images Cloudinary/uploads depuis le frontend (autre origine en dev).
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*', credentials: true }));
app.use(express.json());
app.use(morgan('dev'));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/api', apiLimiter);
app.use('/api/auth/connexion', authLimiter);
app.use('/api/auth/inscription', authLimiter);
app.use('/api/auth/mot-de-passe-oublie', authLimiter);
app.use('/api/auth/reinitialiser-mot-de-passe', authLimiter);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/membres', membersRoutes);
app.use('/api/caisse', caisseRoutes);
app.use('/api/cotisations', cotisationsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/actualites', actualitesRoutes);
app.use('/api/notifications', notificationsRoutes);

app.use((req, res) => res.status(404).json({ message: 'Route introuvable.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Erreur serveur.' });
});

module.exports = app;
