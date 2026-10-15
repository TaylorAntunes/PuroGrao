const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { promotionState, discountFor } = require('../src/promotions');
const { portionPrice } = require('../src/pricing');

test('Tuesday promotion follows the São Paulo calendar at both midnight boundaries', () => {
  for (const [time, active] of [
    ['2026-10-06T02:59:59.999Z', false],
    ['2026-10-06T03:00:00.000Z', true],
    ['2026-10-07T02:59:59.999Z', true],
    ['2026-10-07T03:00:00.000Z', false],
    ['2026-10-13T15:00:00.000Z', true],
  ]) {
    const promotion = promotionState(new Date(time));
    assert.equal(promotion.active, active, time);
    assert.equal(promotion.ends_at, active ? time.startsWith('2026-10-13') ? '2026-10-14T03:00:00.000Z' : '2026-10-07T03:00:00.000Z' : null);
    assert.equal(discountFor({ tuesday_promo: 1 }, promotion), active ? 20 : 0);
    assert.equal(discountFor({ tuesday_promo: 0 }, promotion), 0);
  }
  // Discount the proportional amount before rounding once to cents.
  assert.equal(portionPrice({ price_cents: 1024, price_weight_grams: 1000, discount_percent: 20 }, 25), 20);
  assert.equal(portionPrice({ price_cents: 1024, price_weight_grams: 1000 }, 25), 26);
  assert.equal(portionPrice({ price_cents: 1000000000, price_weight_grams: 1, discount_percent: 20 }, 100000), 80000000000000);
});

test('promotion management, checkout prices and genuine best sellers', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-promotions-'));
  process.env.DB_FILE = path.join(directory, 'test.db');
  process.env.ADMIN_PASSWORD = 'promotion-test-password';
  process.env.ORDER_RATE_MAX_NEW = '1000';
  process.env.ORDER_RATE_MAX_ATTEMPTS = '5000';
  const { db } = require('../src/database');
  const app = express();
  app.use('/api', require('../src/routes/store')(require('../src/database')));
  app.use('/api/admin', require('../src/routes/admin')(require('../src/database')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-06T15:00:00Z') });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token;
  const api = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  token = (await api('/api/admin/login', 'POST', { password: 'promotion-test-password' })).body.token;
  const productBody = { name: 'Produto participante', price: 10.24, stock_grams: 10000, price_weight_grams: 1000, tuesday_promo: true, is_new: true };
  const participant = (await api('/api/admin/products', 'POST', productBody)).body.id;
  const regular = (await api('/api/admin/products', 'POST', { ...productBody, name: 'Preço normal', price: 20, tuesday_promo: false, is_new: false })).body.id;
  const stock = id => db.prepare('SELECT stock_grams FROM products WHERE id=?').get(id).stock_grams;
  const count = () => db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
  const setStatus = (id, status) => api(`/api/admin/orders/${id}`, 'PATCH', { status });

  await t.test('existing products keep regular prices and flags can be managed and preserved', async () => {
    const catalog = (await api('/api/products')).body;
    assert.equal(catalog.promotion.active, true);
    assert.ok(catalog.products.filter(product => product.id <= 9).every(product => product.discount_percent === 0 && product.tuesday_promo === 0 && product.is_new === 0));
    const product = catalog.products.find(product => product.id === participant);
    assert.equal(product.price_cents, 1024);
    assert.equal(product.discount_percent, 20);
    assert.equal(product.is_new, 1);
    const { tuesday_promo, is_new, ...legacyEdit } = productBody;
    assert.equal((await api(`/api/admin/products/${participant}`, 'PUT', legacyEdit)).status, 200);
    const saved = (await api('/api/admin/products')).body.products.find(product => product.id === participant);
    assert.equal(saved.tuesday_promo, 1);
    assert.equal(saved.is_new, 1);
    for (const invalid of [{ tuesday_promo: 'true' }, { is_new: 1 }, { tuesday_promo: null }]) {
      assert.equal((await api(`/api/admin/products/${participant}`, 'PUT', { ...productBody, ...invalid })).status, 400);
    }
  });

  let mixedOrder;
  await t.test('mixed custom portions save discounted cents and WhatsApp totals', async () => {
    const placed = await api('/api/orders', 'POST', {
      customer: 'Cliente', expected_total_cents: 979,
      items: [
        { id: participant, qty: 2, weight_grams: 25, discount_percent: 100, price_cents: 0 },
        { id: participant, qty: 1, weight_grams: 333 },
        { id: regular, qty: 1, weight_grams: 333, discount_percent: 100 },
      ],
    });
    assert.equal(placed.status, 200);
    mixedOrder = placed.body.id;
    assert.equal((await setStatus(mixedOrder, 'confirmado')).status, 200);
    assert.equal(placed.body.total_cents, 979);
    assert.match(new URL(placed.body.whatsapp_url).searchParams.get('text'), /9,79/);
    assert.deepEqual(db.prepare('SELECT price_cents FROM order_items WHERE order_id=? ORDER BY id').all(mixedOrder).map(item => item.price_cents), [20, 273, 666]);
    assert.equal(stock(participant), 9617);
    assert.equal(stock(regular), 9667);
  });

  await t.test('price changes require review and atomically preserve inventory', async () => {
    const before = count();
    const inventory = [stock(participant), stock(regular)];
    t.mock.timers.setTime(new Date('2026-10-07T03:00:00Z').getTime());
    assert.equal((await api('/api/products')).body.products.find(product => product.id === participant).discount_percent, 0);
    const rejected = await api('/api/orders', 'POST', {
      customer: 'Cliente', expected_total_cents: 1485,
      items: [{ id: participant, qty: 1, weight_grams: 1000 }, { id: regular, qty: 1, weight_grams: 333 }],
    });
    assert.equal(rejected.status, 409);
    assert.match(rejected.body.error, /preços ou a promoção mudaram/);
    assert.equal(count(), before);
    assert.deepEqual([stock(participant), stock(regular)], inventory);
    const regularPrice = await api('/api/orders', 'POST', { customer: 'Cliente', expected_total_cents: 1024, items: [{ id: participant, qty: 1, weight_grams: 1000 }] });
    assert.equal(regularPrice.status, 200);
    assert.equal(regularPrice.body.total_cents, 1024);
    assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id=?').get(mixedOrder).total_cents, 979);
  });

  await t.test('removing participation stops Tuesday discounts and does not reprice history', async () => {
    t.mock.timers.setTime(new Date('2026-10-13T15:00:00Z').getTime());
    token = (await api('/api/admin/login', 'POST', { password: 'promotion-test-password' })).body.token;
    assert.equal((await api(`/api/admin/products/${participant}`, 'PUT', { ...productBody, tuesday_promo: false })).status, 200);
    assert.equal((await api('/api/products')).body.products.find(product => product.id === participant).discount_percent, 0);
    assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id=?').get(mixedOrder).total_cents, 979);
    assert.equal((await setStatus(mixedOrder, 'cancelado')).status, 200);
    assert.equal((await setStatus(mixedOrder, 'pago')).status, 200);
    assert.equal(db.prepare('SELECT total_cents FROM orders WHERE id=?').get(mixedOrder).total_cents, 979);
  });

  await t.test('best sellers count paid and delivered orders and exclude cancellations and hidden products', async () => {
    const delivered = await api('/api/orders', 'POST', { customer: 'Cliente', items: [{ id: regular, qty: 1, weight_grams: 100 }] });
    await setStatus(delivered.body.id, 'entregue');
    let catalog = (await api('/api/products')).body.products;
    assert.equal(catalog.find(product => product.id === regular).best_seller_rank, 1);
    assert.equal(catalog.find(product => product.id === participant).best_seller_rank, 2);
    await setStatus(delivered.body.id, 'cancelado');
    catalog = (await api('/api/products')).body.products;
    assert.equal(catalog.find(product => product.id === participant).best_seller_rank, 1);
    assert.equal((await api(`/api/admin/products/${participant}`, 'PUT', { ...productBody, active: false })).status, 200);
    catalog = (await api('/api/products')).body.products;
    assert.equal(catalog.some(product => product.id === participant), false);
    assert.equal(catalog.find(product => product.id === regular).best_seller_rank, 1);
    await setStatus(mixedOrder, 'cancelado');
    assert.ok((await api('/api/products')).body.products.every(product => product.best_seller_rank === null));
  });
});
