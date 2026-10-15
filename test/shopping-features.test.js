const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { shippingFor } = require('../src/shipping');

test('free shipping starts at 50 reais and only applies to Maracanaú deliveries', () => {
  assert.equal(shippingFor(4999, 'delivery', 'Maracanaú').free, false);
  assert.equal(shippingFor(5000, 'delivery', ' MARACANAU ').free, true);
  assert.equal(shippingFor(5000, 'delivery', 'Fortaleza').free, false);
  assert.equal(shippingFor(5000, 'pickup', 'Maracanaú').free, false);
});

test('kit management and automatic shipping use actual products and server totals', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-features-'));
  process.env.DB_FILE = path.join(directory, 'test.db');
  process.env.ADMIN_PASSWORD = 'features-test-password';
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
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-06T22:28:00Z') });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token;
  const api = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  token = (await api('/api/admin/login', 'POST', { password: 'features-test-password' })).body.token;
  const create = async (name, price, promo = false) => (await api('/api/admin/products', 'POST', { name, price, stock_grams: 20000, price_weight_grams: 1000, tuesday_promo: promo })).body.id;
  const regular = await create('Sementes', 50);
  const promo = await create('Granola', 62.5, true);
  const below = await create('Grãos', 62.49, true);
  const component = { id: regular, weight_grams: 250, qty: 2 };
  let kit;

  await t.test('kits persist, validate components and cannot bypass authentication', async () => {
    const created = await api('/api/admin/kits', 'POST', { name: 'Kit Sementes', description: 'Sementes em porções para suas receitas.', components: [component] });
    assert.equal(created.status, 200);
    kit = created.body.id;
    assert.deepEqual((await api('/api/admin/kits')).body.kits.find(item => item.id === kit).components, [component]);
    assert.equal((await api('/api/products')).body.kits.length, 1);
    for (const components of [[], [null], [{ ...component, id: 99999 }], [{ ...component, weight_grams: 1.5 }], [{ ...component, qty: 100 }], [component, component]]) {
      assert.equal((await api('/api/admin/kits', 'POST', { name: 'Kit', components })).status, 400);
    }
    const unauthorized = await fetch(base + '/api/admin/kits', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Kit', components: [component] }) });
    assert.equal(unauthorized.status, 401);
    assert.equal((await api(`/api/admin/products/${regular}`, 'DELETE')).status, 409);
  });
  await t.test('kits consume shared gram inventory and cancellations restore actual portions', async () => {
    const before = db.prepare('SELECT stock_grams FROM products WHERE id=?').get(regular).stock_grams;
    const placed = await api('/api/orders', 'POST', { customer: 'Cliente do kit', items: [component], expected_total_cents: 2500 });
    assert.equal(placed.status, 200);
    assert.equal((await api(`/api/admin/orders/${placed.body.id}`, 'PATCH', { status: 'confirmado' })).status, 200);
    assert.equal(db.prepare('SELECT stock_grams FROM products WHERE id=?').get(regular).stock_grams, before - 500);
    await api(`/api/admin/orders/${placed.body.id}`, 'PATCH', { status: 'cancelado' });
    assert.equal(db.prepare('SELECT stock_grams FROM products WHERE id=?').get(regular).stock_grams, before);
    await api(`/api/admin/kits/${kit}`, 'PUT', { name: 'Kit atualizado', active: false, components: [{ ...component, qty: 1 }] });
    assert.equal((await api('/api/products')).body.kits.length, 0);
    assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id=?').get(placed.body.id).total_cents, 2500);
  });
  await t.test('delivery eligibility uses discounted totals and ignores client free-shipping claims', async () => {
    for (const [id, city, method, free, total] of [
      [below, 'Maracanaú', 'delivery', false, 4999],
      [promo, 'Maracanaú', 'delivery', true, 5000],
      [regular, 'Fortaleza', 'delivery', false, 5000],
      [regular, 'Maracanaú', 'pickup', false, 5000],
    ]) {
      const placed = await api('/api/orders', 'POST', { customer: 'Cliente', address: 'Rua das Sementes, 10', delivery_method: method, delivery_city: city, free_shipping: true, items: [{ id, weight_grams: 1000, qty: 1 }] });
      assert.equal(placed.status, 200);
      assert.equal(placed.body.total_cents, total);
      assert.equal(placed.body.shipping.free, free);
      const saved = db.prepare('SELECT * FROM orders WHERE id=?').get(placed.body.id);
      assert.equal(saved.free_shipping, Number(free));
      assert.equal(saved.delivery_city, city);
      const message = new URL(placed.body.whatsapp_url).searchParams.get('text');
      if (free) assert.match(message, /Frete grátis para Maracanaú/);
      else assert.doesNotMatch(message, /Frete grátis/);
    }
    const before = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
    assert.equal((await api('/api/orders', 'POST', { customer: 'Cliente', delivery_method: 'delivery', items: [component] })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, before);
  });
  await t.test('hidden kit components remove the kit from the public selection', async () => {
    await api(`/api/admin/kits/${kit}`, 'PUT', { name: 'Kit Sementes', components: [component], active: true });
    await api(`/api/admin/products/${regular}`, 'PUT', { name: 'Sementes', price: 50, price_weight_grams: 1000, stock_grams: 10000, active: false });
    assert.equal((await api('/api/products')).body.kits.length, 0);
    assert.equal((await api('/api/admin/kits')).body.kits.length, 1);
    assert.equal((await api(`/api/admin/kits/${kit}`, 'DELETE')).status, 200);
    assert.equal((await api('/api/admin/kits')).body.kits.length, 0);
  });
});
