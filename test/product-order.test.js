const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('catalog ordering migration and authenticated administration preserve shop data', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-product-order-'));
  const filename = path.join(directory, 'ordering.db');
  const password = 'ordering-test-password';
  const originalEnv = { DB_FILE: process.env.DB_FILE, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  process.env.DB_FILE = filename;
  process.env.ADMIN_PASSWORD = password;
  const databaseModule = path.resolve(__dirname, '../src/database.js');
  const startDatabase = () => {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(databaseModule)}).db.close()`], {
      env: { ...process.env, DB_FILE: filename }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  // Build a fully upgraded existing database, then remove only the new order column.
  startDatabase();
  const legacy = new DatabaseSync(filename);
  legacy.exec('DELETE FROM products; DELETE FROM stock_movements; ALTER TABLE products DROP COLUMN display_order;');
  const fixtureInsert = legacy.prepare(`INSERT INTO products(id, name, description, price_cents, cost_cents, category,
    active, sale_unit, stock, stock_grams, stock_units, price_weight_grams, image_data, image_mime, image_version,
    image_position_x, image_position_y, image_fit, tuesday_promo, is_new)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, 8, 20000, 20, 1000, ?, 'image/png', ?, 35, 60, 'contain', 1, 1)`);
  for (const [id, name, category, active, unit] of [
    [11, 'Zulu', 'Sementes', 1, 'weight'], [12, 'Alfa', 'Chás', 1, 'weight'],
    [13, 'Beta', 'Chás', 0, 'unit'], [14, 'Alfa', 'Sementes', 1, 'unit'], [15, 'Alfa', 'Chás', 1, 'weight'],
  ]) fixtureInsert.run(id, name, `Descrição ${id}`, 1000 + id, 500 + id, category, active, unit, Buffer.from([id, 255, 0, 10]), `photo-${id}`);
  legacy.exec(`
    INSERT INTO orders(id, customer, phone, address, notes, total_cents, status, stock_deducted)
      VALUES(21, 'Cliente original', '99999999', 'Rua original', 'Observação original', 1012, 'pago', 1);
    INSERT INTO order_items(order_id, product_id, name, qty, price_cents, cost_cents, weight_grams, stock_grams)
      VALUES(21, 12, 'Nome histórico', 1, 1012, 512, 1000, 1000);
    INSERT INTO stock_movements(product_id, product_name, sale_unit, delta, balance, reason, order_id)
      VALUES(12, 'Nome histórico', 'weight', -1000, 20000, 'sale', 21);
    INSERT INTO kits(id, name, components) VALUES(1, 'Kit original', '[{"id":12,"weight_grams":100,"qty":1}]');
    INSERT INTO site_banner(id, active, title, description, link_label, link_url)
      VALUES(1,1,'Banner original','Descrição original','Ver produtos','#produtos');
  `);
  const snapshot = connection => {
    const result = {};
    const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const { name } of tables) {
      result[name] = connection.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => {
        const normalized = { ...row };
        if (name === 'products') delete normalized.display_order;
        for (const [key, value] of Object.entries(normalized)) if (ArrayBuffer.isView(value)) normalized[key] = Buffer.from(value).toString('hex');
        return normalized;
      });
    }
    return result;
  };
  const original = snapshot(legacy);
  legacy.close();
  const { db } = require('../src/database');
  const { orderedProductIds } = require('../src/product-order');
  const { createApp } = require('../src/app');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('puro-product-order-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';
  async function api(url, method = 'GET', body, authenticated = true) {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...(authenticated && token ? { 'x-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const order = () => orderedProductIds(db);
  const move = (id, position, expectedOrder = order()) => api(`/api/admin/products/${id}/order`, 'PATCH', { position, expected_order: expectedOrder });
  token = (await api('/api/admin/login', 'POST', { password })).body.token;
  assert.ok(token);

  await t.test('migration captures the old category/name/id order once without touching other data', () => {
    assert.deepEqual(order(), [12, 15, 13, 14, 11]);
    assert.deepEqual(db.prepare('SELECT display_order FROM products ORDER BY display_order').all().map(row => row.display_order), [1, 2, 3, 4, 5]);
    assert.deepEqual(snapshot(db), original);
    const column = db.prepare('PRAGMA table_info(products)').all().find(row => row.name === 'display_order');
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, '0');
    assert.throws(() => db.prepare('UPDATE products SET display_order=-1 WHERE id=11').run(), /CHECK constraint/);
    assert.throws(() => db.prepare('UPDATE products SET display_order=NULL WHERE id=11').run(), /NOT NULL constraint/);
  });

  await t.test('public and admin catalogs expose the same order while hidden products remain private', async () => {
    const admin = (await api('/api/admin/products')).body.products;
    const publicProducts = (await api('/api/products')).body.products;
    assert.deepEqual(admin.map(product => product.id), order());
    assert.deepEqual(publicProducts.map(product => product.id), [12, 15, 14, 11]);
    assert.ok(admin.every(product => Number.isSafeInteger(product.display_order)));
    assert.ok(publicProducts.every(product => Number.isSafeInteger(product.display_order)));
    assert.ok(publicProducts.every(product => !Object.hasOwn(product, 'cost_cents')));
  });

  await t.test('unauthenticated callers cannot reorder products', async () => {
    const before = order();
    assert.equal((await api('/api/admin/products/11/order', 'PATCH', { position: 1, expected_order: before }, false)).status, 401);
    assert.deepEqual(order(), before);
  });

  await t.test('first, middle, last and unchanged positions persist without changing stock/photos/orders', async () => {
    const before = snapshot(db);
    assert.deepEqual((await move(11, 1)).body, { ok: true, id: 11, position: 1 });
    assert.deepEqual(order(), [11, 12, 15, 13, 14]);
    assert.equal((await move(11, 3)).status, 200);
    assert.deepEqual(order(), [12, 15, 11, 13, 14]);
    assert.equal((await move(11, 5)).status, 200);
    assert.deepEqual(order(), [12, 15, 13, 14, 11]);
    assert.equal((await move(13, 3)).status, 200);
    assert.deepEqual(order(), [12, 15, 13, 14, 11]);
    assert.deepEqual(snapshot(db), before);
    assert.equal((await move(13, 1)).status, 200);
    startDatabase();
    assert.deepEqual(order(), [13, 12, 15, 14, 11], 'restart preserves a manual order and the hidden product position');
    assert.deepEqual(snapshot(db), before);
  });

  await t.test('hidden products keep their position when reactivated and edits do not reset order', async () => {
    const previous = db.prepare('SELECT * FROM products WHERE id=13').get();
    const body = { name: 'Produto renomeado', price: previous.price_cents / 100, cost: previous.cost_cents / 100,
      category: 'Outra categoria', active: true, sale_unit: 'unit', stock_units: previous.stock_units, display_order: 999 };
    assert.equal((await api('/api/admin/products/13', 'PUT', body)).status, 200);
    assert.equal(db.prepare('SELECT display_order FROM products WHERE id=13').get().display_order, 1);
    const publicProducts = (await api('/api/products')).body.products;
    assert.equal(publicProducts[0].id, 13);
    assert.equal(publicProducts[0].name, 'Produto renomeado');
    assert.deepEqual(order(), [13, 12, 15, 14, 11]);
  });

  await t.test('new products append even if their name/category would previously sort first', async () => {
    const before = order();
    const created = await api('/api/admin/products', 'POST', { name: 'AAA novo', price: 22, category: 'AAA',
      sale_unit: 'unit', stock_units: 20, display_order: 1 });
    assert.equal(created.status, 200);
    assert.deepEqual(order(), [...before, created.body.id]);
    assert.equal(db.prepare('SELECT display_order FROM products WHERE id=?').get(created.body.id).display_order, 6);
    assert.equal((await api('/api/products')).body.products.at(-1).id, created.body.id);
  });

  await t.test('stale ordering snapshots, catalog additions, deletions and unknown products fail atomically', async () => {
    const before = snapshot(db);
    const stale = order();
    assert.equal((await move(11, 1, stale)).status, 200);
    const current = order();
    assert.equal((await move(12, 1, stale)).status, 409);
    assert.deepEqual(order(), current);
    assert.equal((await move(99999, 1)).status, 404);
    assert.equal((await move(12, 1, current.slice(1))).status, 409);
    assert.equal((await move(12, 1, [...current, 99999])).status, 409);
    assert.equal((await move(12, 1, current.filter(id => id !== 13))).status, 409, 'hidden products must be present in the snapshot');
    assert.deepEqual(order(), current);
    assert.deepEqual(snapshot(db), before);
  });

  await t.test('invalid positions and ordering arrays cannot alter any saved data', async () => {
    const expected = order();
    const before = db.prepare('SELECT id, display_order FROM products ORDER BY id').all();
    const saved = snapshot(db);
    for (const position of [undefined, null, -1, 0, 1.5, '1', true, expected.length + 1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await api('/api/admin/products/11/order', 'PATCH', { position, expected_order: expected })).status, 400);
    }
    for (const expectedOrder of [undefined, null, {}, [], ['11'], [null], [0], [-1], [1.5], [true], [...expected, expected[0]]]) {
      assert.equal((await api('/api/admin/products/11/order', 'PATCH', { position: 1, expected_order: expectedOrder })).status, 400);
    }
    for (const id of ['0', '-1', '1.5', 'invalid']) assert.equal((await api(`/api/admin/products/${id}/order`, 'PATCH', { position: 1, expected_order: expected })).status, 400);
    assert.deepEqual(db.prepare('SELECT id, display_order FROM products ORDER BY id').all(), before);
    assert.deepEqual(snapshot(db), saved);
  });

  await t.test('a failed write in the middle of a reorder rolls back every earlier position', async () => {
    const before = db.prepare('SELECT id, display_order FROM products ORDER BY id').all();
    const saved = snapshot(db);
    const current = order();
    db.exec(`CREATE TEMP TRIGGER fail_catalog_order BEFORE UPDATE OF display_order ON products
      WHEN NEW.id=${current[3]} BEGIN SELECT RAISE(ABORT, 'test ordering rollback'); END;`);
    const originalError = console.error;
    console.error = () => {};
    try {
      const failed = await move(current.at(-1), 1);
      assert.equal(failed.status, 500);
      assert.doesNotMatch(failed.body.error, /test ordering rollback/);
    } finally {
      console.error = originalError;
      db.exec('DROP TRIGGER fail_catalog_order');
    }
    assert.deepEqual(db.prepare('SELECT id, display_order FROM products ORDER BY id').all(), before);
    assert.deepEqual(snapshot(db), saved);
  });

  await t.test('direct fixtures with default zero fall after assigned products and can be ordered later', async () => {
    const assigned = order();
    db.prepare("INSERT INTO products(id,name,price_cents,category,active,stock_grams) VALUES(99,'AAA fixture',100,'AAA',1,1000)").run();
    assert.deepEqual(order(), [...assigned, 99]);
    assert.equal((await api('/api/products')).body.products.at(-1).id, 99);
    const stale = assigned;
    assert.equal((await move(11, 1, stale)).status, 409, 'added products invalidate old snapshots');
    assert.equal((await move(99, 1)).status, 200);
    assert.equal(order()[0], 99);
    assert.deepEqual(db.prepare('SELECT display_order FROM products ORDER BY display_order').all().map(row => row.display_order), [1, 2, 3, 4, 5, 6, 7]);
    const beforeDelete = order();
    assert.equal((await api('/api/admin/products/99', 'DELETE')).status, 200);
    const remaining = order();
    assert.equal((await move(11, 1, beforeDelete)).status, 409, 'deleted products invalidate old snapshots');
    assert.deepEqual(order(), remaining);
  });
});

test('new databases assign deterministic order to their initial catalog only once', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-order-new-'));
  const filename = path.join(directory, 'new.db');
  try {
    const result = spawnSync(process.execPath, ['-e', `
      const assert=require('node:assert/strict');
      const {db}=require(${JSON.stringify(path.resolve(__dirname, '../src/database.js'))});
      const products=db.prepare('SELECT id,display_order FROM products ORDER BY display_order').all();
      assert.deepEqual(products.map(product=>product.display_order),products.map((_,index)=>index+1));
      assert.ok(products.length>0);
      db.close();
    `], { env: { ...process.env, DB_FILE: filename }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('puro-order-new-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
