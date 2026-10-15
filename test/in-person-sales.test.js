const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('counter sales share inventory, pricing and the existing order lifecycle safely', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-counter-sales-'));
  const filename = path.join(directory, 'legacy.db');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    price_cents INTEGER NOT NULL, category TEXT DEFAULT 'Geral', color TEXT DEFAULT '#B98A4B', active INTEGER DEFAULT 1,
    stock_grams INTEGER DEFAULT 0, stock_units INTEGER DEFAULT 0, sale_unit TEXT DEFAULT 'weight', price_weight_grams INTEGER DEFAULT 1000);
    CREATE TABLE orders(id INTEGER PRIMARY KEY, customer TEXT, phone TEXT, address TEXT, notes TEXT, total_cents INTEGER,
      status TEXT DEFAULT 'novo', stock_deducted INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE order_items(id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, name TEXT, qty INTEGER,
      price_cents INTEGER, weight_grams INTEGER DEFAULT 0, stock_grams INTEGER DEFAULT 0);
    INSERT INTO products(id,name,price_cents,stock_grams) VALUES(1,'Legado',5000,20000);
    INSERT INTO orders(id,customer,total_cents,status) VALUES(1,'Legado',1000,'novo');`);
  legacy.close();
  process.env.DB_FILE = filename;
  process.env.ADMIN_PASSWORD = 'counter-sales-test-password';
  const { db } = require('../src/database');
  const server = require('../src/app').createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (url, method = 'GET', body, auth = token) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-token': auth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  let token = (await api('/api/admin/login', 'POST', { password: 'counter-sales-test-password' }, '')).body.token;
  const create = async fields => {
    const result = await api('/api/admin/products', 'POST', fields);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.id;
  };
  const createWeight = fields => create({ name: 'Granel', price: 12, price_weight_grams: 250, stock_grams: 20000, cost: 28, ...fields });
  const createUnit = fields => create({ name: 'Cápsulas', price: 45, sale_unit: 'unit', stock_units: 20, cost: 20, ...fields });
  const saleBody = (items, total, extra = {}) => ({ request_id: randomUUID(), items, expected_total_cents: total, payment_method: 'pix', ...extra });
  const submit = body => api('/api/admin/sales', 'POST', body);
  const order = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const stock = id => db.prepare('SELECT stock_grams,stock_units FROM products WHERE id=?').get(id);
  const logs = id => db.prepare('SELECT * FROM stock_movements WHERE order_id=? ORDER BY id').all(id);
  const counts = () => ({ orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
    items: db.prepare('SELECT COUNT(*) AS n FROM order_items').get().n,
    movements: db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,
    requests: db.prepare('SELECT COUNT(*) AS n FROM in_person_sale_requests').get().n });
  const changeStatus = (id, status) => api(`/api/admin/orders/${id}`, 'PATCH', { status });

  await t.test('additive migration preserves legacy orders and counter routes require login', async () => {
    assert.equal(order(1).sales_channel, 'whatsapp');
    assert.equal(order(1).payment_method, '');
    assert.equal(order(1).total_cents, 1000);
    assert.equal(stock(1).stock_grams, 20000);
    assert.equal((await api('/api/admin/sales', 'GET', undefined, '')).status, 401);
    assert.equal((await api('/api/admin/sales', 'POST', {}, '')).status, 401);
  });

  await t.test('mixed counter sales are paid pickups with precise costs and stock history', async () => {
    const weight = await createWeight(), unit = await createUnit();
    const before = (await api('/api/admin/dashboard')).body;
    const result = await submit(saleBody([
      { id: weight, weight_grams: 250, qty: 2 }, { id: unit, sale_unit: 'unit', qty: 2 },
    ], 11400, { customer: 'Cliente do teste', notes: 'Venda do balcão', payment_method: 'dinheiro' }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const saved = order(result.body.id);
    assert.equal(saved.status, 'pago'); assert.equal(saved.sales_channel, 'in_person');
    assert.equal(saved.payment_method, 'dinheiro'); assert.equal(saved.delivery_method, 'pickup');
    assert.equal(saved.free_shipping, 0); assert.equal(saved.total_cents, 11400);
    assert.equal(saved.phone, ''); assert.equal(saved.address, ''); assert.equal(saved.notes, 'Venda do balcão');
    assert.equal(stock(weight).stock_grams, 19500); assert.equal(stock(unit).stock_units, 18);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(saved.id);
    assert.deepEqual(items.map(item => [item.price_cents, item.cost_cents, item.stock_grams, item.stock_units]),
      [[1200, 700, 500, 0], [4500, 2000, 0, 2]]);
    assert.deepEqual(logs(saved.id).map(entry => [entry.reason, entry.delta, entry.balance]),
      [['sale', -500, 19500], ['sale', -2, 18]]);
    const history = (await api('/api/admin/sales')).body.sales.find(sale => sale.id === saved.id);
    assert.equal(history.profit.cost_cents, 5400); assert.equal(history.profit.profit_cents, 6000);
    const after = (await api('/api/admin/dashboard')).body;
    assert.equal(after.day.sales_cents, before.day.sales_cents + 11400);
    assert.equal(after.month.sales_orders, before.month.sales_orders + 1);
    assert.equal(after.profit.month.profit_cents, (before.profit.month.profit_cents || 0) + 6000);
    db.prepare('UPDATE products SET cost_cents=1 WHERE id IN (?,?)').run(weight, unit);
    assert.equal((await api('/api/admin/sales')).body.sales.find(sale => sale.id === saved.id).profit.cost_cents, 5400);
  });

  await t.test('hidden products can sell at the counter without changing the public catalogue', async () => {
    const unit = await createUnit({ active: false });
    const catalog = (await api('/api/admin/sales')).body;
    assert.ok(catalog.products.some(product => product.id === unit && product.active === 0));
    assert.equal(catalog.max_weight_grams, 100000);
    assert.ok(!Object.hasOwn(catalog.products.find(product => product.id === unit), 'cost_cents'));
    assert.ok(!(await api('/api/products')).body.products.some(product => product.id === unit));
    assert.equal((await submit(saleBody([{ id: unit, sale_unit: 'unit', qty: 1 }], 4500))).status, 200);
    assert.equal((await api('/api/orders', 'POST', { customer: 'Teste', items: [{ id: unit, sale_unit: 'unit', qty: 1 }] })).status, 409);
  });

  await t.test('request replay uses the same sale despite price edits, exhaustion, cancellation or deletion', async () => {
    const unit = await createUnit({ stock_units: 1 });
    const body = saleBody([{ id: unit, sale_unit: 'unit', qty: 1 }], 4500);
    const first = await submit(body);
    assert.equal(first.status, 200); assert.equal(first.body.duplicate, false);
    const savedCounts = counts();
    db.prepare('UPDATE products SET price_cents=9900 WHERE id=?').run(unit);
    const replay = await submit(body);
    assert.equal(replay.body.id, first.body.id); assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.total_cents, 4500); assert.deepEqual(counts(), savedCounts);
    assert.equal((await submit({ ...body, payment_method: 'outro' })).status, 409);
    assert.deepEqual(counts(), savedCounts);
    await changeStatus(first.body.id, 'cancelado');
    const cancelled = await submit(body);
    assert.equal(cancelled.body.status, 'cancelado'); assert.equal(stock(unit).stock_units, 1);
    await api(`/api/admin/orders/${first.body.id}`, 'DELETE');
    const afterDelete = counts();
    const deleted = await submit(body);
    assert.equal(deleted.body.duplicate, true); assert.equal(deleted.body.deleted, true);
    assert.equal(deleted.body.id, first.body.id); assert.deepEqual(counts(), afterDelete);
  });

  await t.test('line grouping gives canonical retries and one movement for each product', async () => {
    const weight = await createWeight();
    const body = saleBody([{ id: weight, weight_grams: 250, qty: 1 },
      { id: weight, weight_grams: 500, qty: 1 }, { id: weight, weight_grams: 250, qty: 2 }], 6000);
    const first = await submit(body);
    assert.equal(first.status, 200); assert.equal(stock(weight).stock_grams, 18750);
    assert.equal(logs(first.body.id).length, 1); assert.equal(logs(first.body.id)[0].delta, -1250);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id=?').get(first.body.id).n, 2);
    const replay = await submit({ ...body, request_id: body.request_id.toUpperCase(),
      items: [{ id: weight, weight_grams: 500, qty: 1 }, { id: weight, weight_grams: 250, qty: 3 }] });
    assert.equal(replay.body.duplicate, true); assert.equal(replay.body.id, first.body.id);
  });

  await t.test('invalid data, stale totals and insufficient mixed stock never partially save a sale', async () => {
    const weight = await createWeight(), unit = await createUnit({ stock_units: 0 });
    const valid = saleBody([{ id: weight, weight_grams: 250, qty: 1 }], 1200);
    const before = counts(), balance = stock(weight);
    for (const extra of [{ request_id: '' }, { request_id: 'not-a-uuid' }, { payment_method: 'transferencia' },
      { expected_total_cents: undefined }, { expected_total_cents: '1200' }, { expected_total_cents: -1 },
      { customer: 123 }, { notes: {} }, { items: [] }, { items: [{}] },
      { items: [{ id: weight, weight_grams: 0, qty: 1 }] }, { items: [{ id: weight, weight_grams: 1.5, qty: 1 }] },
      { items: [{ id: weight, weight_grams: 100001, qty: 1 }] },
      { items: [{ id: weight, weight_grams: 250, qty: 100 }] },
      { items: [{ id: unit, sale_unit: 'unit', weight_grams: 250, qty: 1 }] }]) {
      assert.equal((await submit({ ...valid, ...extra })).status, 400, JSON.stringify(extra));
    }
    assert.equal((await submit({ ...valid, expected_total_cents: 1 })).status, 409);
    assert.equal((await submit({ ...valid, items: [...valid.items, { id: unit, sale_unit: 'unit', qty: 1 }] })).status, 409);
    assert.equal((await submit({ ...valid, items: [{ id: weight, sale_unit: 'unit', qty: 1 }] })).status, 409);
    assert.deepEqual(counts(), before); assert.deepEqual(stock(weight), balance);
    assert.equal((await submit(valid)).status, 200, 'Failed attempts must not consume the request identifier');
  });

  await t.test('Tuesday discounts affect selected weights only and preserve cost snapshots', async () => {
    const weight = await createWeight({ tuesday_promo: true }), unit = await createUnit({ tuesday_promo: true });
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-13T12:00:00Z') });
    try {
      token = (await api('/api/admin/login', 'POST', { password: 'counter-sales-test-password' }, '')).body.token;
      const catalog = (await api('/api/admin/sales')).body;
      assert.equal(catalog.promotion.active, true);
      assert.equal(catalog.products.find(product => product.id === weight).discount_percent, 20);
      assert.equal(catalog.products.find(product => product.id === unit).discount_percent, 0);
      const result = await submit(saleBody([{ id: weight, weight_grams: 250, qty: 1 },
        { id: unit, sale_unit: 'unit', qty: 1 }], 5460));
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(db.prepare('SELECT price_cents,cost_cents FROM order_items WHERE order_id=? ORDER BY id').all(result.body.id)
        .map(item => [item.price_cents, item.cost_cents]), [[960, 700], [4500, 2000]]);
    } finally {
      t.mock.timers.reset();
      token = (await api('/api/admin/login', 'POST', { password: 'counter-sales-test-password' }, '')).body.token;
    }
  });

  await t.test('unknown costs remain unknown and existing cancellation/reopening restores exact quantities', async () => {
    const weight = await createWeight({ cost: null }), unit = await createUnit();
    const result = await submit(saleBody([{ id: weight, weight_grams: 350, qty: 2 },
      { id: unit, sale_unit: 'unit', qty: 3 }], 16860));
    assert.equal(result.status, 200);
    assert.equal((await api('/api/admin/sales')).body.sales.find(sale => sale.id === result.body.id).profit, null);
    await changeStatus(result.body.id, 'cancelado'); await changeStatus(result.body.id, 'cancelado');
    assert.equal(stock(weight).stock_grams, 20000); assert.equal(stock(unit).stock_units, 20);
    assert.equal(logs(result.body.id).filter(entry => entry.reason === 'cancellation').length, 2);
    await changeStatus(result.body.id, 'pago');
    assert.equal(stock(weight).stock_grams, 19300); assert.equal(stock(unit).stock_units, 17);
    assert.equal(order(result.body.id).sales_channel, 'in_person'); assert.equal(order(result.body.id).payment_method, 'pix');
  });

  await t.test('database failures roll back stock, items, order, ledger and request together', async () => {
    const unit = await createUnit();
    for (const target of ['stock_movements', 'in_person_sale_requests']) {
      const body = saleBody([{ id: unit, sale_unit: 'unit', qty: 1 }], 4500), before = counts(), balance = stock(unit);
      db.exec(`CREATE TRIGGER block_counter_write BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT, 'test atomic sale'); END;`);
      try {
        assert.equal((await submit(body)).status, 500);
        assert.deepEqual(counts(), before); assert.deepEqual(stock(unit), balance);
      } finally { db.exec('DROP TRIGGER block_counter_write'); }
      assert.equal((await submit(body)).status, 200);
    }
  });

  await t.test('simultaneous identical requests and last-unit sales cannot double deduct', async () => {
    const unit = await createUnit({ stock_units: 1 });
    const body = saleBody([{ id: unit, sale_unit: 'unit', qty: 1 }], 4500);
    const repeated = await Promise.all([submit(body), submit(body)]);
    assert.ok(repeated.every(result => result.status === 200));
    assert.equal(repeated[0].body.id, repeated[1].body.id);
    assert.deepEqual(repeated.map(result => result.body.duplicate).sort(), [false, true]);
    assert.equal(stock(unit).stock_units, 0); assert.equal(logs(repeated[0].body.id).length, 1);
    const other = await createUnit({ stock_units: 1 });
    const competing = await Promise.all([submit(saleBody([{ id: other, sale_unit: 'unit', qty: 1 }], 4500)),
      submit(saleBody([{ id: other, sale_unit: 'unit', qty: 1 }], 4500))]);
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
    assert.equal(stock(other).stock_units, 0);
  });

  await t.test('online checkout keeps its existing contract and cannot impersonate a paid counter sale', async () => {
    const unit = await createUnit();
    const response = await api('/api/orders', 'POST', { customer: 'Teste', sales_channel: 'in_person',
      payment_method: 'pix', status: 'pago', items: [{ id: unit, sale_unit: 'unit', qty: 1 }] });
    assert.equal(response.status, 200); assert.ok(response.body.whatsapp_url);
    assert.equal(order(response.body.id).sales_channel, 'whatsapp');
    assert.equal(order(response.body.id).payment_method, ''); assert.equal(order(response.body.id).status, 'novo');
    assert.ok(!(await api('/api/admin/sales')).body.sales.some(sale => sale.id === response.body.id));
  });
});
