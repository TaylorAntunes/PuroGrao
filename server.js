const path = require('node:path');
try { process.loadEnvFile(path.join(__dirname, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT deve ser uma porta válida entre 0 e 65535.');
const { readSecurityConfig } = require('./src/middleware/security');
const securityConfig = readSecurityConfig();
if (securityConfig.production && !process.env.ADMIN_PASSWORD) {
  throw new Error('Defina ADMIN_PASSWORD antes de iniciar em produção.');
}

const { createApp } = require('./src/app');
const { db } = require('./src/database');
const server = createApp({ securityConfig }).listen(port, securityConfig.host, () => {
  const address = securityConfig.publicOrigin || `http://${securityConfig.host.includes(':') ? `[${securityConfig.host}]` : securityConfig.host}:${server.address().port}`;
  console.log(`Puro Grão no ar: ${address} (admin em /admin)`);
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `A porta ${port} já está em uso.` : 'Não foi possível iniciar o servidor.');
  db.close();
  process.exitCode = 1;
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => { db.close(); });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
