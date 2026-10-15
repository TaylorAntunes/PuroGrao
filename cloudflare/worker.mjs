import { DurableObject } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import application from '../src/app.js';
import schema from '../src/database-schema.js';
import security from '../src/middleware/security.js';
import database from './sqlite-adapter.cjs';
import persistentState from './persistent-map.cjs';
import migration from './importer.cjs';

const requestContext = new AsyncLocalStorage();
// Workers' virtual HTTP registry is isolate-wide: register exactly one server.
const server = createServer((req, res) => {
  const app = requestContext.getStore();
  if (!app) { res.writeHead(503); res.end(); return; }
  app(req, res);
});
server.listen(43000);
const bridge = httpServerHandler({ port: 43000 });
const objectName = 'puro-grao-store-v1';

function configFor(env) {
  return security.readSecurityConfig({
    NODE_ENV: env.ENVIRONMENT === 'development' ? 'development' : 'production',
    HOST: '127.0.0.1', TRUST_PROXY: 'false', PUBLIC_URL: env.PUBLIC_URL || '',
  });
}

function secured(response, request, config) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', security.CONTENT_SECURITY_POLICY);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', security.PERMISSIONS_POLICY);
  headers.delete('X-Powered-By');
  if (config.production && new URL(request.url).protocol === 'https:') {
    headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonError(error, status = 503, extraHeaders = {}) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...extraHeaders } });
}

function transportError(request, config) {
  if (!config.production) return null;
  const url = new URL(request.url);
  if (config.publicHostname && url.hostname !== config.publicHostname) {
    return jsonError('Use o endereço oficial do site.', 421);
  }
  if (url.protocol === 'https:') return null;
  if (config.publicOrigin && ['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 308, headers: {
      Location: config.publicOrigin + url.pathname + url.search, 'Cache-Control': 'no-store',
    } });
  }
  return jsonError('Use uma conexão HTTPS para acessar o site.', 426, { Upgrade: 'TLS/1.2' });
}

export class ShopDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = new database.StorageDatabase(ctx.storage);
    schema.initializeDatabase(this.db, { seed: false });
    this.importer = migration.createImporter(this.db);
    this.env = env;
    this.ctx = ctx;
    this.app = null;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/__migration/')) return this.importer.handle(request, this.env.IMPORT_TOKEN);
    if (!this.importer.isReady()) {
      return jsonError('A loja está sendo preparada. Importe o banco local antes de iniciar os pedidos.');
    }
    if (!this.env.ADMIN_PASSWORD || !/^\d{10,15}$/.test(this.env.WHATSAPP_NUMBER || '')) {
      return jsonError('Configure ADMIN_PASSWORD e WHATSAPP_NUMBER nas variáveis do Worker.');
    }
    if (!this.app) {
      const passwordVersion = createHash('sha256').update(this.env.ADMIN_PASSWORD).digest('hex');
      const settings = new persistentState.SqliteMap(this.db, 'configuration');
      this.db.transaction(() => {
        const previous = settings.get('password-version');
        // A changed password revokes all previous sessions, including if a password
        // is later reused. Login attempt limits remain in their own namespace.
        if (previous !== passwordVersion) {
          this.db.prepare("DELETE FROM __puro_state WHERE namespace LIKE 'sessions:%'").run();
          settings.set('password-version', passwordVersion);
        }
      });
      const state = {
        auth: {
          tokens: new persistentState.SqliteMap(this.db, 'sessions:' + passwordVersion),
          attempts: new persistentState.SqliteMap(this.db, 'login-attempts'),
        },
        orders: new persistentState.SqliteMap(this.db, 'order-limits'),
      };
      this.app = application.createApp({
        database: { db: this.db, transaction: callback => this.db.transaction(callback) },
        env: this.env, state, serveStatic: false, securityConfig: configFor(this.env),
      });
    }
    return requestContext.run(this.app, () => bridge.fetch(request, this.env, this.ctx));
  }
}

export default {
  async fetch(request, env) {
    let config;
    try { config = configFor(env); }
    catch (_) { return secured(jsonError('PUBLIC_URL deve conter a origem HTTPS oficial da loja.'), request, { production: true }); }
    const rejected = transportError(request, config);
    if (rejected) return secured(rejected, request, config);
    const url = new URL(request.url);
    let response;
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/__migration/')) {
        const headers = new Headers(request.headers);
        // Only the Cloudflare edge supplies the client IP. Never trust forwarded
        // headers sent by visitors; the Node bridge reads these two values.
        headers.delete('x-forwarded-for');
        headers.delete('x-forwarded-host');
        headers.set('x-forwarded-proto', url.protocol === 'https:' ? 'https' : 'http');
        headers.set('host', url.host);
        const stub = env.SHOP_DB.get(env.SHOP_DB.idFromName(objectName));
        response = await stub.fetch(new Request(request, { headers }));
      } else if (['GET', 'HEAD'].includes(request.method)) {
        const assetsPath = { '/': '/index.html', '/admin': '/admin.html', '/ofertas': '/offers.html' }[url.pathname];
        if (assetsPath) url.pathname = assetsPath;
        response = await env.ASSETS.fetch(new Request(url, request));
      } else response = jsonError('Página não encontrada.', 404);
    } catch (error) {
      console.error('Falha no Worker Puro Grão:', error.name);
      response = jsonError('Não foi possível atender a solicitação. Tente novamente.', 500);
    }
    return secured(response, request, config);
  },
};
