const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('application routes, validation and administrative sessions', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-app-'));
  process.env.DB_FILE = path.join(directory, 'review.db');
  process.env.ADMIN_PASSWORD = 'review-test-password';
  const { createApp } = require('../src/app');
  const { db } = require('../src/database');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';
  const api = async (url, method = 'GET', body, raw = false) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-token': token }, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }) });
    const data = await response.json();
    return { status: response.status, body: data, headers: response.headers };
  };
  const login = async () => { token = (await api('/api/admin/login', 'POST', { password: 'review-test-password' })).body.token; assert.ok(token); };
  await login();

  await t.test('pages and all browser scripts are served by the real application', async () => {
    for (const route of ['/', '/admin', '/ofertas', '/shared/pricing.js', '/js/admin-dashboard.js', '/js/admin-banner.js', '/js/admin-sales.js', '/css/admin-sales.css', '/js/admin-sales-history.js', '/css/admin-sales-history.css', '/js/search.js']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.equal((await api('/api/missing')).status, 404);
    assert.equal((await api('/api/admin/products')).headers.get('cache-control'), 'no-store');
  });

  await t.test('malformed, oversized and non-object requests return JSON without changing data', async () => {
    const before = db.prepare('SELECT COUNT(*) AS count FROM products').get().count;
    assert.equal((await api('/api/orders', 'POST', '{', true)).status, 400);
    assert.equal((await api('/api/orders', 'POST', [])).status, 400);
    assert.equal((await api('/api/orders', 'POST', { customer: {} })).status, 400);
    assert.equal((await api('/api/orders', 'POST', { customer: 'x'.repeat(60000) })).status, 413);
    const oversizedLogin = await api('/api/admin/login', 'POST', { password: 'x'.repeat(60000) });
    assert.equal(oversizedLogin.status, 413);
    assert.doesNotMatch(oversizedLogin.body.error, /imagem/i);
    const product = { name: 'Teste', price: 10, price_weight_grams: 1000, stock_grams: 1000 };
    for (const invalid of [{ ...product, price: true }, { ...product, name: {} }, { ...product, active: 'false' }, { ...product, description: [] }]) {
      assert.equal((await api('/api/admin/products', 'POST', invalid)).status, 400);
    }
    assert.equal((await api('/api/admin/products', 'POST', [])).status, 400);
    assert.equal((await api('/api/admin/kits', 'POST', { name: {}, components: [{ id: 1, weight_grams: 100, qty: 1 }] })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM products').get().count, before);
    assert.equal((await api('/api/admin/products/99999', 'DELETE')).status, 404);
    assert.equal((await api('/api/admin/kits/99999', 'DELETE')).status, 404);
  });

  await t.test('unsafe totals fail atomically and do not consume stock', async () => {
    const created = await api('/api/admin/products', 'POST', { name: 'Limite', price: 10000000, price_weight_grams: 1, stock_grams: 10000000 });
    assert.equal(created.status, 200);
    const before = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
    const placed = await api('/api/orders', 'POST', { customer: 'Cliente', items: [{ id: created.body.id, weight_grams: 100000, qty: 99 }] });
    assert.equal(placed.status, 400);
    assert.equal(db.prepare('SELECT stock_grams FROM products WHERE id=?').get(created.body.id).stock_grams, 10000000);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, before);
  });

  await t.test('logout revokes a token and login failures are temporarily limited', async () => {
    assert.equal((await api('/api/admin/logout', 'POST')).status, 200);
    assert.equal((await api('/api/admin/products')).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await api('/api/admin/login', 'POST', { password: 'incorrect' })).status, 401);
    const limited = await api('/api/admin/login', 'POST', { password: 'review-test-password' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    t.mock.timers.tick(5 * 60000 + 1);
    await login();
    assert.equal((await api('/api/admin/products')).status, 200);
    t.mock.timers.tick(12 * 3600000);
    assert.equal((await api('/api/admin/products')).status, 401);
  });
});

test('unexpected server errors have a safe JSON response', () => {
  const { errorHandler } = require('../src/middleware/http');
  let status;
  let payload;
  const response = { status(value) { status = value; return this; }, json(value) { payload = value; } };
  const originalError = console.error;
  console.error = () => {};
  try { errorHandler(new Error('private database detail'), {}, response, () => {}); }
  finally { console.error = originalError; }
  assert.equal(status, 500);
  assert.doesNotMatch(payload.error, /private database detail/);
});
