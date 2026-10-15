const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

test('stock migration and order lifecycle', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-stock-'));
  const filename = path.join(directory, 'legacy.db');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      description TEXT DEFAULT '', price_cents INTEGER NOT NULL,
      category TEXT DEFAULT 'Geral', color TEXT DEFAULT '#B98A4B', active INTEGER DEFAULT 1);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, phone TEXT, address TEXT,
      notes TEXT, total_cents INTEGER, status TEXT DEFAULT 'novo', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER,
      name TEXT, qty INTEGER, price_cents INTEGER);
    INSERT INTO products (id, name, price_cents) VALUES (1, 'Produto antigo', 2500);
    INSERT INTO orders (id, customer, total_cents) VALUES (1, 'Cliente antigo', 5000);
    INSERT INTO order_items (order_id, product_id, name, qty, price_cents)
      VALUES (1, 1, 'Produto antigo', 2, 2500);
  `);
  legacy.close();
  const previousEnv = { DB_FILE: process.env.DB_FILE, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  process.env.DB_FILE = filename;
  process.env.ADMIN_PASSWORD = 'test-stock-password';
  process.env.ORDER_RATE_MAX_NEW = '1000';
  process.env.ORDER_RATE_MAX_ATTEMPTS = '5000';
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
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token;
  async function api(url, method = 'GET', body) {
    const response = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  token = (await api('/api/admin/login', 'POST', { password: 'test-stock-password' })).body.token;
  const stock = id => db.prepare('SELECT stock_grams FROM products WHERE id = ?').get(id).stock_grams / 1000;
  const orderCount = () => db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
  const productBody = (quantity, name = 'Teste') => ({ name, price: 12.5, stock_grams: typeof quantity === 'number' ? quantity * 1000 : quantity, price_weight_grams: 1000 });
  async function create(quantity) {
    const response = await api('/api/admin/products', 'POST', productBody(quantity));
    assert.equal(response.status, 200);
    return response.body.id;
  }
  // These inventory fixtures represent orders accepted by staff; pending orders are covered separately.
  const order = async items => {
    const placed = await api('/api/orders', 'POST', { customer: 'Cliente', items: items.map(item => item && { weight_grams: 1000, ...item }) });
    if (placed.status !== 200) return placed;
    const accepted = await api(`/api/admin/orders/${placed.body.id}`, 'PATCH', { status: 'confirmado' });
    return accepted.status === 200 ? placed : accepted;
  };
  const status = (id, value) => api(`/api/admin/orders/${id}`, 'PATCH', { status: value });

  await t.test('legacy data survives migration and cancellation adds no stock', async () => {
    assert.equal(stock(1), 0);
    assert.equal(db.prepare('SELECT name FROM products WHERE id = 1').get().name, 'Produto antigo');
    assert.equal(orderCount(), 1);
    assert.equal((await status(1, 'cancelado')).status, 200);
    assert.equal(stock(1), 0);
    assert.equal((await status(1, 'novo')).status, 200);
    assert.equal((await status(1, 'confirmado')).status, 409);
  });
  await t.test('product stock persists and invalid stock is rejected', async () => {
    const id = await create(8);
    assert.equal((await api(`/api/admin/products/${id}`, 'PUT', productBody(5))).status, 200);
    assert.equal(stock(id), 5);
    const publicProduct = (await api('/api/products')).body.products.find(product => product.id === id);
    assert.equal(publicProduct.stock_grams, 5000);
    for (const quantity of [-1, 1.5, null, '2', Number.MAX_SAFE_INTEGER + 1, undefined]) {
      const invalid = { ...productBody(0), stock_grams: quantity };
      assert.equal((await api('/api/admin/products', 'POST', invalid)).status, 400);
      assert.equal((await api(`/api/admin/products/${id}`, 'PUT', invalid)).status, 400);
    }
    assert.equal(stock(id), 5);
  });
  await t.test('duplicate lines share stock and failed orders roll back every item', async () => {
    const first = await create(5);
    const second = await create(1);
    const before = orderCount();
    assert.equal((await order([{ id: first, qty: 2 }, { id: first, qty: 4 }])).status, 409);
    assert.equal((await order([{ id: first, qty: 2 }, { id: second, qty: 2 }])).status, 409);
    assert.equal(stock(first), 5);
    assert.equal(stock(second), 1);
    assert.equal(orderCount(), before);
    const response = await order([{ id: first, qty: 2 }, { id: first, qty: 3 }]);
    assert.equal(response.status, 200);
    assert.equal(response.body.total_cents, 6250);
    assert.equal(stock(first), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?').get(response.body.id).count, 1);
    assert.equal((await order([{ id: first, qty: 1 }])).status, 409);
  });
  await t.test('invalid quantities and inactive products never consume stock', async () => {
    const id = await create(10);
    for (const items of [[null], [{ id, qty: 1.5 }], [{ id, qty: 0 }], [{ id, qty: 100 }], [{ id, qty: '1' }], [{ id, qty: 99 }, { id, qty: 1 }]]) {
      assert.equal((await order(items)).status, 400);
    }
    assert.equal((await api(`/api/admin/products/${id}`, 'PUT', { ...productBody(10), active: false })).status, 200);
    assert.equal((await order([{ id, qty: 1 }])).status, 409);
    assert.equal(stock(id), 10);
  });
  await t.test('status updates, repeated cancellations and reopenings conserve stock', async () => {
    const id = await create(4);
    const placed = await order([{ id, qty: 3 }]);
    const orderId = placed.body.id;
    assert.equal(stock(id), 1);
    for (const value of ['confirmado', 'pago', 'entregue']) {
      assert.equal((await status(orderId, value)).status, 200);
      assert.equal(stock(id), 1);
    }
    assert.equal((await status(orderId, 'cancelado')).status, 200);
    assert.equal((await status(orderId, 'cancelado')).status, 200);
    assert.equal(stock(id), 4);
    assert.equal((await status(orderId, 'confirmado')).status, 200);
    assert.equal((await status(orderId, 'confirmado')).status, 200);
    assert.equal(stock(id), 1);
    assert.equal((await api(`/api/admin/products/${id}`, 'DELETE')).status, 409);
  });
  await t.test('reopening fails atomically when one product has insufficient stock', async () => {
    const first = await create(3);
    const second = await create(3);
    const placed = await order([{ id: first, qty: 2 }, { id: second, qty: 2 }]);
    assert.equal((await status(placed.body.id, 'cancelado')).status, 200);
    await api(`/api/admin/products/${second}`, 'PUT', productBody(1));
    assert.equal((await status(placed.body.id, 'pago')).status, 409);
    assert.equal(stock(first), 3);
    assert.equal(stock(second), 1);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(placed.body.id).status, 'cancelado');
    assert.equal((await status(placed.body.id, 'cancelado')).status, 200);
    assert.equal(stock(first), 3);
  });
  await t.test('simultaneous orders cannot oversell the last unit', async () => {
    const id = await create(1);
    const responses = await Promise.all(Array.from({ length: 8 }, () => order([{ id, qty: 1 }])));
    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.equal(responses.filter(response => response.status === 409).length, 7);
    assert.equal(stock(id), 0);
  });
  await t.test('preset and custom weights calculate proportional prices on the server', async () => {
    const id = await create(10);
    for (const [grams, price] of [[100, 125], [250, 313], [500, 625], [1000, 1250], [333, 416]]) {
      const response = await order([{ id, qty: 1, weight_grams: grams, price_cents: 1 }]);
      assert.equal(response.status, 200);
      assert.equal(response.body.total_cents, price);
      const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(response.body.id);
      assert.equal(item.weight_grams, grams);
      assert.equal(item.stock_grams, grams);
      const message = new URL(response.body.whatsapp_url).searchParams.get('text');
      assert.match(message, grams === 1000 ? /1 kg/ : new RegExp(`${grams} g`));
    }
    assert.equal(stock(id), 7.817);
  });
  await t.test('different weights share inventory and cancellation uses the saved grams', async () => {
    const id = await create(1);
    const response = await order([{ id, qty: 1, weight_grams: 250 }, { id, qty: 1, weight_grams: 500 }]);
    assert.equal(response.status, 200);
    assert.equal(stock(id), .25);
    assert.equal((await order([{ id, qty: 1, weight_grams: 100 }, { id, qty: 1, weight_grams: 250 }])).status, 409);
    assert.equal(stock(id), .25);
    await api(`/api/admin/products/${id}`, 'PUT', { ...productBody(.25), price_weight_grams: 100 });
    assert.equal((await status(response.body.id, 'cancelado')).status, 200);
    assert.equal(stock(id), 1);
    assert.equal((await status(response.body.id, 'confirmado')).status, 200);
    assert.equal(stock(id), .25);
  });
  await t.test('invalid custom weights never create an order or deduct inventory', async () => {
    const id = await create(1);
    for (const weight of [0, -1, 100001, 1.5, '250', null]) {
      assert.equal((await order([{ id, qty: 1, weight_grams: weight }])).status, 400);
    }
    assert.equal(stock(id), 1);
  });
  await t.test('product images save, replace, persist on edits, and can be removed', async () => {
    const file = fs.readFileSync(path.join(__dirname, '../public/images/logo-horizontal.png'));
    const dataUrl = 'data:image/png;base64,' + file.toString('base64');
    const created = await api('/api/admin/products', 'POST', { ...productBody(1), image_data_url: dataUrl, image_position_x: 20, image_position_y: 75, image_fit: 'cover' });
    assert.equal(created.status, 200);
    const id = created.body.id;
    const product = (await api('/api/products')).body.products.find(product => product.id === id);
    assert.ok(product.image_url.startsWith(`/api/products/${id}/image?v=`));
    assert.equal(product.image_position_x, 20);
    assert.equal(product.image_position_y, 75);
    assert.equal(Object.hasOwn(product, 'image_data'), false);
    const saved = await fetch(base + product.image_url);
    assert.equal(saved.headers.get('content-type'), 'image/png');
    assert.equal(saved.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), file);
    assert.equal((await api(`/api/admin/products/${id}`, 'PUT', productBody(2))).status, 200);
    const preserved = (await api('/api/admin/products')).body.products.find(product => product.id === id);
    assert.equal(preserved.image_url, product.image_url);
    assert.equal(preserved.image_position_x, 20);
    assert.equal(preserved.image_position_y, 75);
    assert.equal(preserved.image_fit, 'cover');
    assert.equal((await api(`/api/admin/products/${id}`, 'PUT', { ...productBody(2), image_position_x: 50, image_position_y: 50, image_fit: 'contain' })).status, 200);
    const centered = (await api('/api/products')).body.products.find(product => product.id === id);
    assert.equal(centered.image_url, product.image_url);
    assert.equal(centered.image_position_x, 50);
    assert.equal(centered.image_position_y, 50);
    assert.equal(centered.image_fit, 'contain');
    assert.equal(Object.hasOwn(preserved, 'image_data'), false);
    const replacement = fs.readFileSync(path.join(__dirname, '../public/images/logo-vertical.png'));
    assert.equal((await api(`/api/admin/products/${id}`, 'PUT', { ...productBody(2), image_data_url: 'data:image/png;base64,' + replacement.toString('base64') })).status, 200);
    const changed = (await api('/api/products')).body.products.find(product => product.id === id);
    assert.notEqual(changed.image_url, product.image_url);
    assert.deepEqual(Buffer.from(await (await fetch(base + changed.image_url)).arrayBuffer()), replacement);
    assert.equal((await api(`/api/admin/products/${id}`, 'PUT', { ...productBody(2), image_data_url: null })).status, 200);
    assert.equal((await api('/api/products')).body.products.find(product => product.id === id).image_url, '');
    assert.equal((await fetch(base + changed.image_url)).status, 404);
  });
  await t.test('invalid images reject the whole product change and oversized requests return JSON', async () => {
    const id = await create(1);
    for (const value of [42, 'https://example.com/image.png', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,aGVsbG8=', 'data:image/jpeg;base64,aGVsbG8=']) {
      assert.equal((await api('/api/admin/products', 'POST', { ...productBody(2), image_data_url: value })).status, 400);
      assert.equal((await api(`/api/admin/products/${id}`, 'PUT', { ...productBody(2), image_data_url: value })).status, 400);
      assert.equal(stock(id), 1);
    }
    const tooBig = 'data:image/png;base64,' + Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    assert.equal((await api('/api/admin/products', 'POST', { ...productBody(2), image_data_url: tooBig })).status, 400);
    const response = await api('/api/admin/products', 'POST', { ...productBody(2), image_data_url: 'x'.repeat(7 * 1024 * 1024) });
    assert.equal(response.status, 413);
    assert.match(response.body.error, /5 MB/);
    const unauthenticated = await fetch(base + '/api/admin/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...productBody(2), image_data_url: tooBig }) });
    assert.equal(unauthenticated.status, 401);
  });
  await t.test('invalid image placement does not change the product or its inventory', async () => {
    const id = await create(1);
    for (const layout of [{ image_position_x: -1 }, { image_position_x: 101 }, { image_position_y: 1.5 }, { image_position_y: '50' }, { image_position_y: null }, { image_fit: 'stretch' }, { image_fit: null }]) {
      assert.equal((await api('/api/admin/products', 'POST', { ...productBody(2), ...layout })).status, 400);
      assert.equal((await api(`/api/admin/products/${id}`, 'PUT', { ...productBody(2), ...layout })).status, 400);
      assert.equal(stock(id), 1);
    }
    const product = (await api('/api/products')).body.products.find(product => product.id === id);
    assert.equal(product.image_position_x, 50);
    assert.equal(product.image_position_y, 50);
    assert.equal(product.image_fit, 'cover');
  });
  await t.test('restart preserves stock and new databases start with zero stock', () => {
    const probe = "const {db}=require('./src/database'); console.log(JSON.stringify(db.prepare('SELECT id,stock_grams FROM products ORDER BY id').all())); db.close();";
    const restarted = spawnSync(process.execPath, ['-e', probe], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
    assert.equal(restarted.status, 0, restarted.stderr);
    const expected = db.prepare('SELECT id,stock_grams FROM products ORDER BY id').all().map(row => ({ ...row }));
    assert.deepEqual(JSON.parse(restarted.stdout), expected);
    const fresh = spawnSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: path.join(directory, 'fresh.db') }, encoding: 'utf8',
    });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(JSON.parse(fresh.stdout).length, 9);
    assert.ok(JSON.parse(fresh.stdout).every(product => product.stock_grams === 0));
  });
  await t.test('unit inventory migrates once and preserves old order prices and stock deductions', () => {
    const migratedFile = path.join(directory, 'units.db');
    const old = new DatabaseSync(migratedFile);
    old.exec(`CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, description TEXT, price_cents INTEGER, stock INTEGER);
      CREATE TABLE orders(id INTEGER PRIMARY KEY, status TEXT, stock_deducted INTEGER);
      CREATE TABLE order_items(id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, name TEXT, qty INTEGER, price_cents INTEGER);
      INSERT INTO products VALUES(1, 'Granola', 'Aveia e coco. 400 g', 2400, 6);
      INSERT INTO orders VALUES(1, 'novo', 1);
      INSERT INTO order_items VALUES(1, 1, 1, 'Granola', 2, 2400);`);
    old.close();
    const probe = "const {db}=require('./src/database'); console.log(JSON.stringify({p:db.prepare('SELECT * FROM products').get(),i:db.prepare('SELECT * FROM order_items').get()}));db.close();";
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, ['-e', probe], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_FILE: migratedFile }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const { p, i } = JSON.parse(result.stdout);
      assert.equal(p.stock_grams, 2400);
      assert.equal(p.price_weight_grams, 400);
      assert.equal(p.price_cents, 2400);
      assert.equal(i.price_cents, 2400);
      assert.equal(i.weight_grams, 0);
      assert.equal(i.stock_grams, 800);
    }
  });
});
