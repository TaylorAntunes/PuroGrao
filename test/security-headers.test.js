const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { configureSecurity, readSecurityConfig } = require('../src/middleware/security');
const { errorHandler } = require('../src/middleware/http');

function policy(response) {
  return Object.fromEntries(response.headers.get('content-security-policy').split(';').map(directive => {
    const [name, ...values] = directive.trim().split(/\s+/);
    return [name, values];
  }));
}

function assertHeaders(response) {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(response.headers.get('permissions-policy'), /camera=\(\).*microphone=\(\).*geolocation=\(\)/);
  assert.equal(response.headers.has('x-powered-by'), false);
  const directives = policy(response);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['script-src-attr'], ["'none'"]);
  assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['connect-src'], ["'self'"]);
  assert.ok(!directives['script-src'].includes("'unsafe-inline'"));
  assert.ok(!directives['script-src'].includes("'unsafe-eval'"));
  return directives;
}

test('transport configuration requires explicit, restricted proxy trust and a canonical HTTPS origin', () => {
  const local = readSecurityConfig({});
  assert.equal(local.production, false);
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.trustProxy, false);
  assert.equal(local.publicOrigin, null);
  const published = readSecurityConfig({ NODE_ENV: 'production', HOST: '0.0.0.0',
    TRUST_PROXY: '127.0.0.1/32, ::1/128', PUBLIC_URL: 'https://Shop.Example:8443/' });
  assert.equal(published.production, true);
  assert.equal(published.publicOrigin, 'https://shop.example:8443');
  assert.equal(published.publicHostname, 'shop.example');
  assert.deepEqual(published.trustProxy, ['127.0.0.1/32', '::1/128']);
  assert.deepEqual(readSecurityConfig({ TRUST_PROXY: 'loopback' }).trustProxy, ['loopback']);
  for (const TRUST_PROXY of ['true', '*', '1', '2', '0.0.0.0/0', '::/0', '192.168.1.1/33',
    '::1/129', 'proxy.example', '127.0.0.1,', 'uniquelocal', 'linklocal']) {
    assert.throws(() => readSecurityConfig({ TRUST_PROXY }), /TRUST_PROXY/, TRUST_PROXY);
  }
  for (const PUBLIC_URL of ['http://shop.example', '//shop.example', 'https://user:secret@shop.example',
    'https://shop.example/catalogo', 'https://shop.example/?x=1', 'https://shop.example/#section', 'invalid']) {
    assert.throws(() => readSecurityConfig({ PUBLIC_URL }), /PUBLIC_URL/);
  }
  assert.throws(() => readSecurityConfig({ HOST: 'https://localhost' }), /HOST/);
});

test('security headers protect the real application while local HTTP continues working', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-security-headers-'));
  process.env.DB_FILE = path.join(directory, 'test.db');
  process.env.ADMIN_PASSWORD = 'temporary-security-header-password';
  const { db } = require('../src/database');
  const { createApp } = require('../src/app');
  const servers = [];
  const serve = async config => {
    const server = createApp({ securityConfig: readSecurityConfig(config) }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  t.after(async () => {
    await Promise.all(servers.map(server => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    }));
    db.close();
    // The cleanup is limited to this freshly-created temporary directory.
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const local = await serve({});
  // Native HTTP preserves hostile Host/path values that fetch intentionally normalises.
  const request = (base, route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const address = new URL(base);
    const outgoing = http.request({ hostname: address.hostname, port: address.port, path: route, method, headers }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, {
        status: incoming.statusCode, headers: incoming.headers,
      })));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });

  await t.test('HTML, static assets, APIs, missing resources and JSON errors receive the policy', async () => {
    for (const [route, status] of [['/', 200], ['/admin', 200], ['/ofertas', 200], ['/js/admin.js', 200],
      ['/css/store.css', 200], ['/shared/pricing.js', 200], ['/api/products', 200],
      ['/api/admin/products', 401], ['/api/missing', 404], ['/missing-page', 404]]) {
      const response = await request(local, route);
      assert.equal(response.status, status, route);
      assertHeaders(response);
      assert.equal(response.headers.has('strict-transport-security'), false, route);
      assert.equal(Object.hasOwn(policy(response), 'upgrade-insecure-requests'), false);
    }
    const invalid = await request(local, '/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(invalid.status, 400);
    assertHeaders(invalid);
    const oversized = await request(local, '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(60000) }),
    });
    assert.equal(oversized.status, 413);
    assertHeaders(oversized);
  });

  await t.test('existing fonts, uploaded images and style attributes remain permitted without inline scripts', async () => {
    const response = await request(local, '/admin');
    const directives = assertHeaders(response);
    assert.deepEqual(directives['style-src'], ["'self'", 'https://fonts.googleapis.com']);
    assert.deepEqual(directives['style-src-attr'], ["'unsafe-inline'"]);
    assert.deepEqual(directives['font-src'], ["'self'", 'https://fonts.gstatic.com']);
    assert.deepEqual(directives['img-src'], ["'self'", 'data:', 'blob:']);
    const html = await response.text();
    assert.match(html, /https:\/\/fonts\.googleapis\.com/);
    assert.match(html, /<script src="\/js\/admin\.js/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[^\s<]/i);
  });

  await t.test('untrusted forwarded headers cannot turn local HTTP into HTTPS', async () => {
    const response = await request(local, '/admin', {
      headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'attacker.example' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.has('strict-transport-security'), false);
    assert.equal(response.headers.has('location'), false);
  });

  await t.test('production HTTP rejects credentials and orders before reading the body or changing stock', async () => {
    const production = await serve({ NODE_ENV: 'production' });
    const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    for (const route of ['/', '/api/admin/login', '/api/orders']) {
      const response = await request(production, route, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: '{',
      });
      assert.equal(response.status, 426, route);
      assertHeaders(response);
      assert.equal(response.headers.has('location'), false);
      assert.equal(response.headers.has('strict-transport-security'), false);
      assert.equal(response.headers.get('upgrade'), 'TLS/1.2');
    }
    assert.equal((await request(production, '/')).status, 426);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before);
  });

  await t.test('production redirects safe reads only to the configured origin and rejects hostile hosts or paths', async () => {
    const production = await serve({ NODE_ENV: 'production', PUBLIC_URL: 'https://shop.example:8443' });
    const response = await request(production, '/admin?next=https%3A%2F%2Fattacker.example', { headers: { Host: 'shop.example' } });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://shop.example:8443/admin?next=https%3A%2F%2Fattacker.example');
    assertHeaders(response);
    assert.equal(response.headers.has('strict-transport-security'), false);
    for (const Host of ['attacker.example', 'shop.example.attacker.example']) {
      const hostile = await request(production, '/admin', { headers: { Host, 'X-Forwarded-Host': 'shop.example' } });
      assert.equal(hostile.status, 421);
      assert.equal(hostile.headers.has('location'), false);
    }
    for (const Host of ['shop.example/attacker.example', 'user@shop.example', 'shop.example,attacker.example']) {
      assert.equal((await request(production, '/', { headers: { Host } })).status, 400);
    }
    for (const route of ['//attacker.example/admin', '/\\attacker.example/admin']) {
      const invalid = await request(production, route, { headers: { Host: 'shop.example' } });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.headers.has('location'), false);
    }
    const mutation = await request(production, '/api/orders', { method: 'POST', headers: { Host: 'shop.example' } });
    assert.equal(mutation.status, 426);
    assert.equal(mutation.headers.has('location'), false);
  });

  await t.test('only an explicitly trusted proxy can supply HTTPS and secure production requests do not redirect', async () => {
    const production = await serve({ NODE_ENV: 'production', TRUST_PROXY: '127.0.0.1/32', PUBLIC_URL: 'https://shop.example' });
    const secure = await request(production, '/admin', { headers: { Host: 'shop.example', 'X-Forwarded-Proto': 'https' } });
    assert.equal(secure.status, 200);
    assertHeaders(secure);
    assert.equal(secure.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal(secure.headers.has('location'), false);
    const insecure = await request(production, '/admin', { headers: { Host: 'shop.example', 'X-Forwarded-Proto': 'http' } });
    assert.equal(insecure.status, 308);
    assert.equal(insecure.headers.has('strict-transport-security'), false);
    const untrusted = await serve({ NODE_ENV: 'production', TRUST_PROXY: '203.0.113.7/32', PUBLIC_URL: 'https://shop.example' });
    const spoofed = await request(untrusted, '/admin', { headers: { Host: 'shop.example', 'X-Forwarded-Proto': 'https' } });
    assert.equal(spoofed.status, 308);
    assert.equal(spoofed.headers.has('strict-transport-security'), false);
  });

  await t.test('unexpected errors keep defensive headers and do not expose private details', async () => {
    const app = express();
    app.disable('x-powered-by');
    configureSecurity(app, readSecurityConfig({}));
    app.get('/error', (req, res, next) => next(new Error('Private test-only detail')));
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    servers.push(server);
    const log = t.mock.method(console, 'error', () => {});
    try {
      const response = await request(`http://127.0.0.1:${server.address().port}`, '/error');
      assert.equal(response.status, 500);
      assertHeaders(response);
      assert.doesNotMatch(await response.text(), /Private test-only detail/);
    } finally { log.mock.restore(); }
  });
});
