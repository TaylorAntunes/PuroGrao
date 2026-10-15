const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { portionPrice } = require('../shared/pricing');
const { discountFor, promotionState } = require('../src/promotions');

test('products sold by units preserve stock, prices, kits and order history', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-units-'));
  process.env.DB_FILE = path.join(directory, 'units.db');
  process.env.ADMIN_PASSWORD = 'units-test-password';
  process.env.ORDER_RATE_MAX_NEW = '1000';
  process.env.ORDER_RATE_MAX_ATTEMPTS = '5000';
  const { db } = require('../src/database');
  const server = require('../src/app').createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    // This directory was created by mkdtemp specifically for this test.
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token;
  async function api(url, method = 'GET', body) {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  token = (await api('/api/admin/login', 'POST', { password: 'units-test-password' })).body.token;
  const unitBody = stock => ({ name: 'Mel em pote', price: 12.5, sale_unit: 'unit', stock_units: stock, tuesday_promo: true });
  const weightBody = stock => ({ name: 'Sementes', price: 20, sale_unit: 'weight', stock_grams: stock, price_weight_grams: 1000 });
  const create = async body => {
    const result = await api('/api/admin/products', 'POST', body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.id;
  };
  const product = id => db.prepare('SELECT * FROM products WHERE id=?').get(id);
  const status = (id, value) => api(`/api/admin/orders/${id}`, 'PATCH', { status: value });
  const order = async (items, extra = {}) => {
    const placed = await api('/api/orders', 'POST', { customer: 'Cliente', items, ...extra });
    if (placed.status !== 200) return placed;
    const accepted = await api(`/api/admin/orders/${placed.body.id}`, 'PATCH', { status: 'confirmado' });
    return accepted.status === 200 ? placed : accepted;
  };
  const unitItem = (id, qty) => ({ id, sale_unit: 'unit', weight_grams: 0, qty });
  const weightItem = (id, grams, qty) => ({ id, weight_grams: grams, qty });
  const units = await create(unitBody(10));
  const weight = await create(weightBody(5000));

  await t.test('existing products default to weight and unit choices persist across startup', async () => {
    assert.equal(product(1).sale_unit, 'weight');
    const publicProduct = (await api('/api/products')).body.products.find(item => item.id === units);
    assert.equal(publicProduct.sale_unit, 'unit');
    assert.equal(publicProduct.stock_units, 10);
    const restart = spawnSync(process.execPath, ['-e', "const {db}=require('./src/database');console.log(JSON.stringify(db.prepare('SELECT sale_unit,stock_units FROM products WHERE id=?').get(Number(process.argv[1]))));db.close()", String(units)], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
    assert.equal(restart.status, 0, restart.stderr);
    assert.deepEqual(JSON.parse(restart.stdout.trim()), { sale_unit: 'unit', stock_units: 10 });
  });

  await t.test('unit prices do not scale by grams or receive the Tuesday granel discount', async () => {
    const value = product(units);
    assert.equal(portionPrice(value, 0), 1250);
    assert.equal(portionPrice(value, 100000), 1250);
    assert.equal(discountFor(value, promotionState(new Date('2026-10-06T15:00:00Z'))), 0);
  });

  await t.test('fractional or invalid stock and unknown selling methods are rejected atomically', async () => {
    for (const stock of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await api(`/api/admin/products/${units}`, 'PUT', unitBody(stock))).status, 400);
    }
    for (const sale_unit of ['kg', 'piece', null, 1]) {
      assert.equal((await api(`/api/admin/products/${units}`, 'PUT', { ...unitBody(10), sale_unit })).status, 400);
    }
    assert.equal(product(units).stock_units, 10);
    assert.equal((await api(`/api/admin/products/${units}`, 'PUT', { ...unitBody(10), sale_unit: undefined })).status, 200);
    assert.equal(product(units).sale_unit, 'unit');
  });

  await t.test('mixed orders use unit quantities, snapshot the measure and restore both inventories exactly once', async () => {
    const placed = await order([unitItem(units, 2), weightItem(weight, 250, 2)], { expected_total_cents: 3500 });
    assert.equal(placed.status, 200);
    assert.equal(placed.body.total_cents, 3500);
    assert.equal(product(units).stock_units, 8);
    assert.equal(product(weight).stock_grams, 4500);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY product_id').all(placed.body.id);
    assert.equal(items[0].sale_unit, 'unit');
    assert.equal(items[0].stock_units, 2);
    assert.equal(items[0].stock_grams, 0);
    assert.equal(items[0].weight_grams, 0);
    const message = new URL(placed.body.whatsapp_url).searchParams.get('text');
    assert.match(message, /2x Mel em pote \(1 unidade\)/);
    assert.match(message, /2x Sementes \(250 g\)/);
    await status(placed.body.id, 'cancelado');
    await status(placed.body.id, 'cancelado');
    assert.equal(product(units).stock_units, 10);
    assert.equal(product(weight).stock_grams, 5000);
    assert.equal((await status(placed.body.id, 'confirmado')).status, 200);
    assert.equal(product(units).stock_units, 8);
    await status(placed.body.id, 'cancelado');
  });

  await t.test('invalid quantities, misleading weights, type mismatches and stale totals never consume stock', async () => {
    for (const item of [unitItem(units, 1.5), unitItem(units, 0), unitItem(units, 100), { ...unitItem(units, 1), weight_grams: 100 }, { ...unitItem(units, 1), sale_unit: 'piece' }]) {
      assert.equal((await order([item])).status, 400);
    }
    for (const items of [[weightItem(units, 100, 1)], [unitItem(weight, 1)], [unitItem(units, 6), unitItem(units, 5)], [weightItem(weight, 100, 1), unitItem(units, 11)]]) {
      assert.equal((await order(items)).status, 409);
    }
    assert.equal((await order([unitItem(units, 1)], { expected_total_cents: 1 })).status, 409);
    assert.equal(product(units).stock_units, 10);
    assert.equal(product(weight).stock_grams, 5000);
  });

  await t.test('duplicate unit lines merge and simultaneous buyers cannot oversell', async () => {
    const id = await create(unitBody(3));
    const placed = await order([unitItem(id, 1), { id, sale_unit: 'unit', qty: 2 }]);
    assert.equal(placed.status, 200);
    assert.equal(placed.body.total_cents, 3750);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id=?').get(placed.body.id).n, 1);
    await status(placed.body.id, 'cancelado');
    await api(`/api/admin/products/${id}`, 'PUT', unitBody(1));
    const results = await Promise.all([order([unitItem(id, 1)]), order([unitItem(id, 1)])]);
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
    assert.equal(product(id).stock_units, 0);
  });

  await t.test('unit subtotals qualify for free shipping and dashboard displays quantities without grams', async () => {
    const placed = await order([unitItem(units, 4)], { delivery_method: 'delivery', delivery_city: 'Maracanaú', address: 'Rua 1' });
    assert.equal(placed.body.total_cents, 5000);
    assert.equal(placed.body.shipping.free, true);
    await status(placed.body.id, 'pago');
    const dashboard = (await api('/api/admin/dashboard')).body;
    const seller = dashboard.best_sellers.find(item => item.product_id === units);
    assert.equal(seller.units, 4);
    assert.equal(seller.weight_grams, 0);
    assert.equal(seller.weight_portions, 0);
    assert.equal(seller.sales_cents, 5000);
    const low = await create(unitBody(3));
    const before = (await api('/api/admin/dashboard')).body.stock.low_stock;
    await api(`/api/admin/products/${low}`, 'PUT', unitBody(4));
    assert.equal((await api('/api/admin/dashboard')).body.stock.low_stock, before - 1);
    await status(placed.body.id, 'cancelado');
  });

  await t.test('mixed kits preserve selling units and invalid weights cannot change the saved kit', async () => {
    const components = [unitItem(units, 2), weightItem(weight, 250, 1)];
    const created = await api('/api/admin/kits', 'POST', { name: 'Kit Café da Manhã', components });
    assert.equal(created.status, 200);
    const kit = (await api('/api/products')).body.kits.find(item => item.id === created.body.id);
    assert.deepEqual(kit.components, components);
    assert.equal((await api(`/api/admin/kits/${kit.id}`, 'PUT', { name: 'Kit', components: [{ ...unitItem(units, 2), weight_grams: 100 }] })).status, 400);
    const placed = await order(kit.components);
    assert.equal(placed.body.total_cents, 3000);
    await status(placed.body.id, 'cancelado');
    await api(`/api/admin/products/${units}`, 'PUT', { ...weightBody(7000), name: 'Mel por peso' });
    assert.equal((await api('/api/products')).body.kits.some(item => item.id === kit.id), false);
    assert.equal((await api(`/api/admin/kits/${kit.id}`, 'PUT', { name: 'Kit', components })).status, 400);
    await api(`/api/admin/products/${units}`, 'PUT', unitBody(10));
  });

  await t.test('changing the selling method keeps order history and cancellation inventory in the original measure', async () => {
    const id = await create(unitBody(5));
    const placed = await order([unitItem(id, 2)]);
    await api(`/api/admin/products/${id}`, 'PUT', weightBody(7000));
    assert.equal((await status(placed.body.id, 'cancelado')).status, 200);
    assert.equal(product(id).stock_grams, 7000);
    assert.equal(product(id).stock_units, 5);
    assert.equal((await status(placed.body.id, 'confirmado')).status, 409);
    assert.equal(product(id).stock_grams, 7000);
    assert.equal(product(id).stock_units, 5);
    const saved = (await api('/api/admin/orders')).body.orders.find(item => item.id === placed.body.id).items[0];
    assert.equal(saved.sale_unit, 'unit');
    assert.equal(saved.price_cents, 1250);
    await api(`/api/admin/products/${id}`, 'PUT', unitBody(5));
    assert.equal((await status(placed.body.id, 'confirmado')).status, 200);
    assert.equal(product(id).stock_units, 3);
  });
});
