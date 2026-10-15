const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('administrative order deletion preserves inventory and removes history atomically', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-delete-order-'));
  process.env.DB_FILE = path.join(directory, 'test.db');
  process.env.ADMIN_PASSWORD = 'order-deletion-test';
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
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, method = 'GET', body, token = '') => {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', 'x-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const token = (await request('/api/admin/login', 'POST', { password: 'order-deletion-test' })).body.token;
  const weight = (await request('/api/admin/products', 'POST', {
    name: 'Produto por peso', price: 10, price_weight_grams: 1000, stock_grams: 10000,
  }, token)).body.id;
  const unit = (await request('/api/admin/products', 'POST', {
    name: 'Produto por unidade', price: 5, sale_unit: 'unit', stock_units: 20,
  }, token)).body.id;
  async function order() {
    const result = await request('/api/orders', 'POST', { customer: 'Teste', items: [
      { id: weight, qty: 2, weight_grams: 250 },
      { id: unit, qty: 2, sale_unit: 'unit' },
    ] });
    assert.equal(result.status, 200);
    return result.body.id;
  }
  const inventory = () => db.prepare('SELECT id, stock_grams, stock_units FROM products ORDER BY id').all();
  const remove = id => request(`/api/admin/orders/${id}`, 'DELETE', undefined, token);

  await t.test('requires authentication and rejects invalid or missing orders', async () => {
    const id = await order();
    assert.equal((await request(`/api/admin/orders/${id}`, 'DELETE')).status, 401);
    assert.ok(db.prepare('SELECT 1 FROM orders WHERE id=?').get(id));
    for (const invalid of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
      assert.equal((await remove(invalid)).status, 400);
    }
    assert.equal((await remove(999999)).status, 404);
  });

  await t.test('deletes only the chosen order and its items across all statuses without changing stock', async () => {
    const retained = db.prepare('SELECT id FROM orders ORDER BY id LIMIT 1').get().id;
    for (const status of ['novo', 'confirmado', 'pago', 'entregue', 'cancelado']) {
      const id = await order();
      assert.equal((await request(`/api/admin/orders/${id}`, 'PATCH', { status }, token)).status, 200);
      const before = inventory();
      const dashboard = (await request('/api/admin/dashboard', 'GET', undefined, token)).body;
      assert.equal((await remove(id)).status, 200);
      assert.equal(db.prepare('SELECT 1 FROM orders WHERE id=?').get(id), undefined);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id=?').get(id).n, 0);
      assert.deepEqual(inventory(), before);
      assert.ok(db.prepare('SELECT 1 FROM orders WHERE id=?').get(retained));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id=?').get(retained).n, 2);
      const after = (await request('/api/admin/dashboard', 'GET', undefined, token)).body;
      assert.equal(after.month.orders, dashboard.month.orders - 1);
      assert.equal(after.month.sales_cents, dashboard.month.sales_cents - (['pago', 'entregue'].includes(status) ? 1500 : 0));
      assert.equal((await remove(id)).status, 404);
      assert.deepEqual(inventory(), before);
    }
  });

  await t.test('legacy orders without inventory deduction do not change stock', async () => {
    const id = db.prepare("INSERT INTO orders(customer, total_cents) VALUES('Antigo', 1000)").run().lastInsertRowid;
    db.prepare('INSERT INTO order_items(order_id, product_id, name, qty, price_cents) VALUES(?, ?, ?, 1, 1000)').run(id, weight, 'Produto antigo');
    const before = inventory();
    assert.equal((await remove(id)).status, 200);
    assert.deepEqual(inventory(), before);
  });

  await t.test('a database failure rolls back the removal of both order and items', async () => {
    const id = await order();
    const before = inventory();
    db.exec(`CREATE TRIGGER block_order_deletion BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
    try {
      assert.equal((await remove(id)).status, 500);
      assert.ok(db.prepare('SELECT 1 FROM orders WHERE id=?').get(id));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id=?').get(id).n, 2);
      assert.deepEqual(inventory(), before);
    } finally {
      db.exec('DROP TRIGGER block_order_deletion');
    }
  });
});
