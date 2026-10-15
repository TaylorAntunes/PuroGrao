const express = require('express');
const path = require('node:path');
const { apiNotFound, errorHandler } = require('./middleware/http');
const { configureSecurity, readSecurityConfig } = require('./middleware/security');

function createApp({ securityConfig = readSecurityConfig() } = {}) {
  const app = express();
  const publicDirectory = path.join(__dirname, '..', 'public');
  app.disable('x-powered-by');
  configureSecurity(app, securityConfig);
  app.use(express.static(publicDirectory));
  app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
  app.get('/admin', (_, res) => res.sendFile(path.join(publicDirectory, 'admin.html')));
  app.get('/ofertas', (_, res) => res.sendFile(path.join(publicDirectory, 'offers.html')));
  app.use('/api', require('./routes/store'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api', apiNotFound);
  app.use((req, res) => res.status(404).type('text/plain').send('Página não encontrada.'));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
