const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { portionCost, marginPercent } = require('../shared/profitability');

test('gross margin and portion costs use kilos, units and cent rounding', () => {
  assert.equal(portionCost({ sale_unit: 'weight', cost_cents: 2800 }, 250), 700);
  assert.equal(portionCost({ sale_unit: 'weight', cost_cents: 5 }, 100), 1);
  assert.equal(portionCost({ sale_unit: 'unit', cost_cents: 2800 }, 0), 2800);
  assert.equal(portionCost({ sale_unit: 'weight', cost_cents: null }, 250), null);
  assert.equal(portionCost({ sale_unit: 'weight', cost_cents: 0 }, 250), 0);
  assert.ok(Math.abs(marginPercent(4900, 2800) - 42.857142857) < 0.000001);
  assert.equal(marginPercent(0, 2800), null);
  assert.equal(marginPercent(1000, 2000), -100);
});

test('inventory ledger and cost snapshots preserve the existing order lifecycle', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-inventory-profit-'));
  const filename = path.join(directory, 'legacy.db');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
    price_cents INTEGER NOT NULL, category TEXT DEFAULT 'Geral', color TEXT DEFAULT '#B98A4B', active INTEGER DEFAULT 1,
    stock_grams INTEGER DEFAULT 0, stock_units INTEGER DEFAULT 0, sale_unit TEXT DEFAULT 'weight', price_weight_grams INTEGER DEFAULT 1000);
    CREATE TABLE orders(id INTEGER PRIMARY KEY, customer TEXT, phone TEXT, address TEXT, notes TEXT, total_cents INTEGER,
    status TEXT DEFAULT 'novo', stock_deducted INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE order_items(id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, name TEXT, qty INTEGER,
    price_cents INTEGER, weight_grams INTEGER DEFAULT 0, stock_grams INTEGER DEFAULT 0);
    INSERT INTO products(id,name,price_cents,stock_grams) VALUES(1,'Produto antigo',4900,8000);
    INSERT INTO orders(id,customer,total_cents,status,stock_deducted,created_at) VALUES(1,'Antigo',1225,'pago',1,'2026-10-08 12:00:00');
    INSERT INTO order_items(order_id,product_id,name,qty,price_cents,weight_grams,stock_grams) VALUES(1,1,'Produto antigo',1,1225,250,250);`);
  legacy.close();
  process.env.DB_FILE = filename;
  process.env.ADMIN_PASSWORD = 'inventory-test-password';
  process.env.ORDER_RATE_MAX_NEW = '1000';
  process.env.ORDER_RATE_MAX_ATTEMPTS = '5000';
  const { db } = require('../src/database');
  const server = require('../src/app').createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-08T12:00:00Z') });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (url, method = 'GET', body, auth = token) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-token': auth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const token = (await api('/api/admin/login', 'POST', { password: 'inventory-test-password' }, '')).body.token;
  const weightBody = stock => ({ name: 'Castanhas', price: 49, price_weight_grams: 1000, stock_grams: stock, cost: 28 });
  const unitBody = stock => ({ name: 'Pote', price: 10, sale_unit: 'unit', stock_units: stock, cost: 4 });
  const create = async body => {
    const result = await api('/api/admin/products', 'POST', body);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.id;
  };
  const movements = id => db.prepare('SELECT * FROM stock_movements WHERE product_id=? ORDER BY id').all(id);
  const product = id => db.prepare('SELECT * FROM products WHERE id=?').get(id);
  const inventory = () => db.prepare('SELECT id,stock_grams,stock_units,cost_cents FROM products ORDER BY id').all();
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n;
  const history = (query = '') => api('/api/admin/stock-movements' + query);
  const move = (id, delta, reason = 'purchase', extra = {}) => api('/api/admin/stock-movements', 'POST',
    { product_id: id, sale_unit: product(id).sale_unit, delta, reason, note: 'Conferência do teste', ...extra });
  const order = async items => {
    const result = await api('/api/orders', 'POST', { customer: 'Teste', items });
    if (result.status === 200) {
      db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(new Date().toISOString(), result.body.id);
      const accepted = await api(`/api/admin/orders/${result.body.id}`, 'PATCH', { status: 'confirmado' });
      if (accepted.status !== 200) return accepted;
    }
    return result;
  };
  const status = (id, value) => api(`/api/admin/orders/${id}`, 'PATCH', { status: value });
  let weight, unit, sale;

  await t.test('migration starts once with the actual balance and leaves old costs unknown', () => {
    assert.equal(product(1).stock_grams, 8000);
    assert.equal(product(1).cost_cents, null);
    assert.equal(db.prepare('SELECT cost_cents FROM order_items WHERE order_id=1').get().cost_cents, null);
    assert.deepEqual(movements(1).map(item => [item.reason, item.delta, item.balance]), [['initial', 8000, 8000]]);
    const restart = spawnSync(process.execPath, ['-e', "const {db}=require('./src/database');console.log(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n);db.close();"], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8', windowsHide: true });
    assert.equal(restart.status, 0, restart.stderr);
    assert.equal(Number(restart.stdout), count());
  });

  await t.test('cost and stock history remain private; only supported movements can be submitted', async () => {
    assert.equal((await api('/api/admin/stock-movements', 'GET', undefined, '')).status, 401);
    assert.equal((await api('/api/admin/stock-movements', 'POST', {}, '')).status, 401);
    weight = await create(weightBody(8000)); unit = await create(unitBody(10));
    const publicProduct = (await api('/api/products')).body.products.find(item => item.id === weight);
    assert.equal(Object.hasOwn(publicProduct, 'cost'), false);
    assert.equal(Object.hasOwn(publicProduct, 'cost_cents'), false);
    assert.equal((await api('/api/admin/products')).body.products.find(item => item.id === weight).cost, 28);
    for (const cost of [-1, '28', {}, false, 10000001]) assert.equal((await api(`/api/admin/products/${weight}`, 'PUT', { ...weightBody(8000), cost })).status, 400);
    const before = count();
    for (const extra of [{ delta: 0 }, { delta: 1.5 }, { delta: '10' }, { reason: 'sale' }, { reason: 'purchase', delta: -1 }, { note: '' }, { note: 'a'.repeat(301) }]) {
      assert.equal((await move(weight, 10, 'purchase', extra)).status, 400);
    }
    assert.equal((await move(weight, 1, 'purchase', { sale_unit: 'unit' })).status, 409);
    assert.equal((await move(weight, -9000, 'manual_adjustment')).status, 409);
    assert.equal((await move(weight, Number.MAX_SAFE_INTEGER)).status, 409);
    assert.equal(product(weight).stock_grams, 8000); assert.equal(count(), before);
  });

  await t.test('purchases, adjustments and product edits have signed deltas and exact balances', async () => {
    assert.equal((await move(weight, 10000)).status, 200);
    assert.equal((await move(weight, -1000, 'manual_adjustment')).status, 200);
    assert.equal((await api(`/api/admin/products/${weight}`, 'PUT', weightBody(16000))).status, 200);
    const before = count();
    assert.equal((await api(`/api/admin/products/${weight}`, 'PUT', { ...weightBody(16000), cost: 29 })).status, 200);
    assert.equal(count(), before, 'A cost-only edit must not create stock movement');
    assert.equal((await api(`/api/admin/products/${weight}`, 'PUT', weightBody(16000))).status, 200);
    assert.deepEqual(movements(weight).map(item => [item.reason, item.delta, item.balance]),
      [['initial',8000,8000],['purchase',10000,18000],['manual_adjustment',-1000,17000],['product_edit',-1000,16000]]);
    assert.equal((await move(unit, 5)).status, 200);
    assert.equal(product(unit).stock_units, 15);
  });

  await t.test('failed mixed orders and stale prices never leave movements behind', async () => {
    const before = inventory(), logs = count();
    assert.equal((await order([{ id: weight, weight_grams: 250, qty: 1 }, { id: unit, sale_unit: 'unit', qty: 99 }])).status, 409);
    assert.equal((await api('/api/orders', 'POST', { customer: 'Teste', expected_total_cents: 1, items: [{ id: weight, weight_grams: 250, qty: 1 }] })).status, 409);
    assert.deepEqual(inventory(), before); assert.equal(count(), logs);
  });

  await t.test('mixed sales snapshot costs and cancellation/reopening conserve both measures exactly once', async () => {
    sale = (await order([{ id: weight, weight_grams: 250, qty: 1 }, { id: unit, sale_unit: 'unit', qty: 2 }])).body.id;
    assert.ok(sale);
    const items = db.prepare('SELECT cost_cents FROM order_items WHERE order_id=? ORDER BY id').all(sale);
    assert.deepEqual(items.map(item => item.cost_cents), [700, 400]);
    assert.deepEqual(movements(weight).at(-1).delta, -250);
    assert.equal(movements(weight).at(-1).balance, 15750);
    const before = count();
    await status(sale, 'confirmado'); await status(sale, 'pago'); await status(sale, 'entregue');
    assert.equal(count(), before);
    await status(sale, 'cancelado'); await status(sale, 'cancelado');
    assert.equal(count(), before + 2);
    assert.equal(product(weight).stock_grams, 16000); assert.equal(product(unit).stock_units, 15);
    await status(sale, 'pago');
    assert.equal(count(), before + 4);
    assert.equal(product(weight).stock_grams, 15750); assert.equal(product(unit).stock_units, 13);
    assert.equal(movements(weight).at(-1).reason, 'reopening');
  });

  await t.test('historical profit survives cost changes and excludes orders with incomplete costs', async () => {
    await api(`/api/admin/products/${weight}`, 'PUT', { ...weightBody(product(weight).stock_grams), cost: 40 });
    const orders = (await api('/api/admin/orders')).body.orders;
    const profit = orders.find(order => order.id === sale).profit;
    assert.equal(profit.cost_cents, 1500); assert.equal(profit.profit_cents, 1725);
    assert.equal(orders.find(order => order.id === 1).profit, null);
    const dashboard = (await api('/api/admin/dashboard')).body;
    assert.equal(dashboard.profit.month.known_orders, 1);
    assert.equal(dashboard.profit.month.unknown_orders, 1);
    assert.equal(dashboard.profit.month.cost_cents, 1500);
    assert.equal(dashboard.profit.month.profit_cents, 1725);
    assert.ok(Math.abs(dashboard.profit.month.margin_percent - 1725 / 3225 * 100) < 0.000001);
    await status(sale, 'cancelado');
    assert.equal((await api('/api/admin/dashboard')).body.profit.month.profit_cents, null);
    await status(sale, 'pago');
  });

  await t.test('failed reopenings roll back stock and history, including the earlier products', async () => {
    await status(sale, 'cancelado');
    await move(unit, -product(unit).stock_units, 'manual_adjustment');
    const before = inventory(), logs = count();
    assert.equal((await status(sale, 'confirmado')).status, 409);
    assert.deepEqual(inventory(), before); assert.equal(count(), logs);
    await move(unit, 15); await status(sale, 'pago');
  });

  await t.test('deleted orders retain movements and references cannot be reused', async () => {
    const before = inventory(), logs = count();
    assert.equal((await api(`/api/admin/orders/${sale}`, 'DELETE')).status, 200);
    assert.deepEqual(inventory(), before); assert.equal(count(), logs);
    const next = await order([{ id: weight, qty: 1, weight_grams: 100 }]);
    assert.ok(next.body.id > sale);
    const disposable = await create(unitBody(3));
    await api(`/api/admin/products/${disposable}`, 'DELETE');
    const replacement = await create(unitBody(1));
    assert.ok(replacement > disposable);
    assert.ok((await history(`?product_id=${disposable}`)).body.products.find(item => item.id === disposable).deleted);
  });

  await t.test('cost omission preserves values, clearing preserves unknowns and zero is a valid cost', async () => {
    const body = { ...weightBody(product(weight).stock_grams) }; delete body.cost;
    await api(`/api/admin/products/${weight}`, 'PUT', body);
    assert.equal(product(weight).cost_cents, 4000);
    await api(`/api/admin/products/${weight}`, 'PUT', { ...body, cost: null });
    assert.equal(product(weight).cost_cents, null);
    await api(`/api/admin/products/${weight}`, 'PUT', { ...body, cost: 0 });
    assert.equal(product(weight).cost_cents, 0);
    const result = await order([{ id: weight, qty: 1, weight_grams: 100 }]);
    assert.equal(db.prepare('SELECT cost_cents FROM order_items WHERE order_id=?').get(result.body.id).cost_cents, 0);
  });

  await t.test('Tuesday discounts reduce estimated profit while retaining the original cost snapshot', async () => {
    t.mock.timers.setTime(new Date('2026-10-06T12:00:00Z').getTime());
    await api(`/api/admin/products/${weight}`, 'PUT', { ...weightBody(product(weight).stock_grams), tuesday_promo: true });
    const result = await order([{ id: weight, weight_grams: 1000, qty: 1 }]);
    assert.equal(result.body.total_cents, 3920);
    const saved = (await api('/api/admin/orders')).body.orders.find(order => order.id === result.body.id);
    assert.equal(saved.profit.cost_cents, 2800); assert.equal(saved.profit.profit_cents, 1120);
    assert.ok(Math.abs(saved.profit.margin_percent - 1120 / 3920 * 100) < 0.000001);
    t.mock.timers.setTime(new Date('2026-10-08T12:00:00Z').getTime());
  });

  await t.test('measure changes keep separate balances and reset costs if not explicitly supplied', async () => {
    const id = await create(weightBody(2000));
    await api(`/api/admin/products/${id}`, 'PUT', { name: 'Agora por unidade', price: 10, sale_unit: 'unit', stock_units: 6 });
    assert.equal(product(id).cost_cents, null);
    assert.equal(product(id).stock_grams, 2000);
    const last = movements(id).at(-1); assert.equal(last.sale_unit, 'unit'); assert.equal(last.balance, 6);
    assert.equal((await move(id, 1, 'purchase', { sale_unit: 'weight' })).status, 409);
  });

  await t.test('a ledger write failure rolls back purchases, edits, orders and cancellations', async () => {
    const placed = await order([{ id: weight, weight_grams: 100, qty: 1 }]);
    const pending = await api('/api/orders', 'POST', { customer: 'Teste', items: [{ id: weight, weight_grams: 100, qty: 1 }] });
    assert.equal(pending.status, 200);
    const before = inventory(), logs = count();
    const ordersBefore = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    db.exec("CREATE TRIGGER ledger_failure BEFORE INSERT ON stock_movements BEGIN SELECT RAISE(ABORT, 'ledger rollback test'); END;");
    const expectedLog = t.mock.method(console, 'error', () => {});
    try {
      assert.equal((await move(weight, 100)).status, 500);
      assert.equal((await api(`/api/admin/products/${weight}`, 'PUT', weightBody(product(weight).stock_grams + 100))).status, 500);
      assert.equal((await status(pending.body.id, 'confirmado')).status, 500);
      assert.equal((await status(placed.body.id, 'cancelado')).status, 500);
      assert.equal((await api('/api/admin/products', 'POST', unitBody(1))).status, 500);
      assert.deepEqual(inventory(), before); assert.equal(count(), logs);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, ordersBefore);
      assert.equal(db.prepare('SELECT stock_deducted FROM orders WHERE id=?').get(placed.body.id).stock_deducted, 1);
    } finally { db.exec('DROP TRIGGER ledger_failure'); expectedLog.mock.restore(); }
  });

  await t.test('simultaneous manual removals cannot consume the same last units', async () => {
    const id = await create(unitBody(1));
    const results = await Promise.all([move(id, -1, 'manual_adjustment'), move(id, -1, 'manual_adjustment')]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal(product(id).stock_units, 0);
    assert.equal(movements(id).length, 2);
  });

  await t.test('history filters and pagination expose all entries without duplicates', async () => {
    for (let index = 0; index < 55; index++) await move(unit, 1);
    const query = `?product_id=${unit}&reason=purchase`;
    const first = (await history(query)).body, second = (await history(query + '&offset=50')).body;
    assert.equal(first.movements.length, 50); assert.equal(first.total, 57);
    assert.equal(second.movements.length, 7);
    assert.equal(new Set([...first.movements, ...second.movements].map(item => item.id)).size, 57);
    for (const filter of ['?offset=-1', '?product_id=no', '?reason=no']) assert.equal((await history(filter)).status, 400);
  });
});
