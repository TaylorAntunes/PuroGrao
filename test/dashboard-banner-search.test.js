const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { matches } = require('../public/js/search');
const { periodStart } = require('../src/dashboard');

test('search tolerates spelling variants, accents and adjacent swaps without matching unrelated short words', () => {
  const psyllium = { name: 'Psyllium', category: 'Fibras', description: 'A granel' };
  for (const query of ['psilium', 'psylliun', 'psillium', 'PSYLLIUM', 'psilium fibras', 'psyll']) assert.equal(matches(psyllium, query), true, query);
  assert.equal(matches({ name: 'Granola artesanal' }, 'granloa'), true);
  assert.equal(matches({ name: 'Castanha-do-pará' }, 'castnha para'), true);
  assert.equal(matches({ name: 'Amêndoas', description: 'Sem sal' }, 'amendoas sal'), true);
  assert.equal(matches({ name: 'Semente de chia' }, 'chá'), false);
  assert.equal(matches(psyllium, 'castanha'), false);
  assert.equal(matches(psyllium, 'psilium chocolate'), false);
  assert.equal(matches(psyllium, '   '), true);
});

test('calendar boundaries follow Sao Paulo, including a skipped midnight', () => {
  assert.equal(periodStart(new Date('2026-11-01T04:00:00Z'), 'day'), '2026-11-01T03:00:00.000Z');
  assert.equal(periodStart(new Date('2026-11-15T04:00:00Z'), 'month'), '2026-11-01T03:00:00.000Z');
  assert.equal(periodStart(new Date('2018-11-04T15:00:00Z'), 'day'), '2018-11-04T03:00:00.000Z');
});

test('dashboard and banner APIs use persistent data and authenticated administration', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-dashboard-'));
  const filename = path.join(directory, 'preview.db');
  process.env.DB_FILE = filename;
  process.env.ADMIN_PASSWORD = 'dashboard-test-password';
  const { db } = require('../src/database');
  const app = express();
  app.use('/api', require('../src/routes/store'));
  app.use('/api/admin', require('../src/routes/admin'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T04:00:00Z') });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (url, method = 'GET', body, token = '') => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  let token = (await api('/api/admin/login', 'POST', { password: 'dashboard-test-password' })).body.token;

  await t.test('private metrics and banner editing require authentication', async () => {
    assert.equal((await api('/api/admin/dashboard')).status, 401);
    assert.equal((await api('/api/admin/banner')).status, 401);
    assert.equal((await api('/api/admin/banner', 'PUT', {})).status, 401);
    const empty = (await api('/api/admin/dashboard', 'GET', undefined, token)).body;
    assert.equal(empty.day.sales_cents, 0);
    assert.equal(empty.month.average_ticket_cents, 0);
    assert.deepEqual(empty.best_sellers, []);
  });

  await t.test('metrics include all orders, use paid/delivered sales, and respect local month boundaries', async () => {
    db.exec('UPDATE products SET stock_grams=5000; UPDATE products SET stock_grams=3000 WHERE id=1; UPDATE products SET stock_grams=0, active=0 WHERE id=2;');
    const insert = db.prepare('INSERT INTO orders(customer, status, total_cents, created_at) VALUES(?, ?, ?, ?)');
    insert.run('Anterior', 'pago', 9900, '2026-11-01 02:59:59');
    const paid = insert.run('Pago', 'pago', 1000, '2026-11-01 03:00:00').lastInsertRowid;
    const delivered = insert.run('Entregue', 'entregue', 3000, '2026-11-01 03:20:00').lastInsertRowid;
    insert.run('Novo', 'novo', 4000, '2026-11-01 03:30:00');
    insert.run('Confirmado', 'confirmado', 5000, '2026-11-01 03:40:00');
    insert.run('Cancelado', 'cancelado', 6000, '2026-11-01 03:50:00');
    insert.run('Futuro', 'pago', 100000, '2026-12-01 03:00:00');
    for (let i = 0; i < 205; i++) insert.run('Pendente', 'novo', 8000, '2026-11-01 03:40:00');
    const item = db.prepare('INSERT INTO order_items(order_id, product_id, name, qty, price_cents, weight_grams) VALUES(?, ?, ?, ?, ?, ?)');
    item.run(paid, 2, 'Quinoa', 2, 500, 100);
    item.run(delivered, 1, 'Granola', 1, 3000, 500);
    let dashboard = (await api('/api/admin/dashboard', 'GET', undefined, token)).body;
    assert.deepEqual(dashboard.day, { orders: 210, sales_orders: 2, sales_cents: 4000, pending_orders: 207, cancelled_orders: 1, average_ticket_cents: 2000 });
    assert.deepEqual(dashboard.month, dashboard.day);
    assert.deepEqual(dashboard.stock, { low_stock: 2, sold_out: 1 });
    assert.equal(dashboard.best_sellers[0].product_id, 2);
    assert.equal(dashboard.best_sellers[0].weight_grams, 200);
    assert.equal(dashboard.best_sellers[0].sales_cents, 1000);
    assert.equal((await api('/api/admin/orders', 'GET', undefined, token)).body.orders.length, 200);
    await api(`/api/admin/orders/${delivered}`, 'PATCH', { status: 'cancelado' }, token);
    dashboard = (await api('/api/admin/dashboard', 'GET', undefined, token)).body;
    assert.equal(dashboard.day.sales_cents, 1000);
    assert.equal(dashboard.day.average_ticket_cents, 1000);
    assert.equal(dashboard.day.cancelled_orders, 2);
    assert.equal(dashboard.best_sellers.length, 1);
    t.mock.timers.setTime(new Date('2026-11-02T04:00:00Z').getTime());
    // Renew the token because a session lasts 12 hours.
    const renewed = (await api('/api/admin/login', 'POST', { password: 'dashboard-test-password' })).body.token;
    dashboard = (await api('/api/admin/dashboard', 'GET', undefined, renewed)).body;
    assert.equal(dashboard.day.sales_cents, 0);
    assert.equal(dashboard.month.sales_cents, 1000);
    t.mock.timers.setTime(new Date('2026-11-01T04:00:00Z').getTime());
    token = (await api('/api/admin/login', 'POST', { password: 'dashboard-test-password' })).body.token;
  });

  await t.test('banner publishes, persists, updates and hides without changing discounts', async () => {
    assert.equal((await api('/api/products')).body.banner, null);
    const banner = { active: true, title: 'Sabores da semana', description: 'Conheça nossa seleção <especial>.', link_label: 'Ver produtos', link_url: '/#produtos' };
    assert.deepEqual((await api('/api/admin/banner', 'PUT', banner, token)).body.banner, banner);
    assert.deepEqual((await api('/api/products')).body.banner, banner);
    const persisted = new DatabaseSync(filename);
    assert.equal(persisted.prepare('SELECT title FROM site_banner WHERE id=1').get().title, banner.title);
    persisted.close();
    const changed = { ...banner, title: 'Ofertas do dia', link_url: '/ofertas' };
    assert.equal((await api('/api/admin/banner', 'PUT', changed, token)).status, 200);
    assert.equal((await api('/api/products')).body.banner.title, changed.title);
    await api('/api/admin/banner', 'PUT', { ...changed, active: false }, token);
    assert.equal((await api('/api/products')).body.banner, null);
    assert.equal((await api('/api/admin/banner', 'GET', undefined, token)).body.banner.title, changed.title);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM site_banner').get().count, 1);
  });

  await t.test('invalid links and incomplete content cannot overwrite the saved banner', async () => {
    const saved = (await api('/api/admin/banner', 'GET', undefined, token)).body.banner;
    for (const bad of [{ ...saved, active: true, title: '' }, { ...saved, title: 'x'.repeat(101) }, { ...saved, active: 'true' }, { ...saved, link_label: '' }, null,
      ...['javascript:alert(1)', 'data:text/html,x', '//evil.example', '//puro-grao.local', '/\\evil.example', 'https://name:password@example.com', '/x\n//evil'].map(link_url => ({ ...saved, link_url }))]) {
      assert.equal((await api('/api/admin/banner', 'PUT', bad, token)).status, 400);
    }
    assert.deepEqual((await api('/api/admin/banner', 'GET', undefined, token)).body.banner, saved);
    for (const link_url of ['#produtos', '/ofertas', 'https://example.com/promocao', 'https://wa.me/5585999999999']) {
      assert.equal((await api('/api/admin/banner', 'PUT', { ...saved, link_url }, token)).status, 200);
    }
  });
});
