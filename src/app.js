const express = require('express');
const path = require('node:path');
const { apiNotFound, errorHandler } = require('./middleware/http');
const { configureSecurity, readSecurityConfig } = require('./middleware/security');

function createApp({ database, env = process.env, state = {}, serveStatic = true,
  securityConfig = readSecurityConfig(env) } = {}) {
  const { db, transaction } = database || require('./database');
  const app = express();
  const publicDirectory = serveStatic ? path.join(__dirname, '..', 'public') : null;
  app.disable('x-powered-by');
  configureSecurity(app, securityConfig);
  if (serveStatic) {
    app.use(express.static(publicDirectory));
    app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
    app.get('/admin', (_, res) => res.sendFile(path.join(publicDirectory, 'admin.html')));
    app.get('/ofertas', (_, res) => res.sendFile(path.join(publicDirectory, 'offers.html')));
  }
  const options = { db, transaction, env, state };
  app.use('/api', require('./routes/store')(options));
  app.use('/api/admin', require('./routes/admin')(options));
  app.use('/api', apiNotFound);
  app.use((req, res) => res.status(404).type('text/plain').send('Página não encontrada.'));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
