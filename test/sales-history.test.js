const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

test('private sales history reads complete order snapshots with safe filters and pagination', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-sales-history-'));
  process.env.DB_FILE = path.join(directory, 'test.db');
  process.env.ADMIN_PASSWORD = 'sales-history-test-password';
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
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const token = (await api('/api/admin/login', 'POST', { password: 'sales-history-test-password' }, '')).body.token;
  const history = query => api('/api/admin/sales-history' + (query ? `?${query}` : ''));
  const insertOrder = db.prepare(`INSERT INTO orders(customer,phone,total_cents,status,created_at,sales_channel)
    VALUES(?,?,?,?,?,?)`);
  const insertItem = db.prepare(`INSERT INTO order_items(order_id,product_id,name,qty,price_cents,cost_cents,
    weight_grams,stock_grams,sale_unit,stock_units) VALUES(?,1,?,1,?,?,250,250,'weight',0)`);
  const fixture = (customer, total, status, date, channel = 'whatsapp', phone = '85999999999', cost = 400) => {
    const id = Number(insertOrder.run(customer, phone, total, status, date, channel).lastInsertRowid);
    insertItem.run(id, 'Nome na venda', total, cost);
    return id;
  };
  const ids = {};
  db.exec('BEGIN');
  try {
    ids.pending = fixture('José Ávila', 1200, 'novo', '2026-10-10 12:00:00', 'whatsapp', '85981234567');
    ids.confirmed = fixture('Confirmação', 1300, 'confirmado', '2026-10-10T12:30:00.000Z');
    ids.paid = fixture('João', 1400, 'pago', '2026-10-10 13:00:00');
    ids.delivered = fixture('Maria', 1500, 'entregue', '2026-10-10T14:00:00.000Z');
    ids.cancelled = fixture('Cancelamento', 1600, 'cancelado', '2026-10-10 15:00:00');
    ids.counter = fixture('Cliente presencial', 4500, 'pago', '2026-10-10 16:00:00', 'in_person');
    ids.noCost = fixture('Custo desconhecido', 800, 'pago', '2026-10-10 17:00:00', 'whatsapp', '', null);
    insertItem.run(ids.paid, 'Segundo item original', 0, 0);
    for (let i = 0; i < 231; i++) fixture(`Página ${i}`, 1000 + i, 'pago', '2026-10-09 12:00:00');
    ids.beforeStart = fixture('Antes do início', 900, 'pago', '2026-10-11T02:59:59.999Z');
    ids.atStart = fixture('Início do dia', 901, 'pago', '2026-10-11 03:00:00');
    ids.lastMillis = fixture('Último milissegundo', 902, 'entregue', '2026-10-12T02:59:59.999Z');
    ids.nextDay = fixture('Próximo dia', 903, 'pago', '2026-10-12 03:00:00');
    ids.dstBefore = fixture('DST antes', 904, 'pago', '2018-11-04T02:59:59.999Z');
    ids.dstStart = fixture('DST início', 905, 'pago', '2018-11-04 03:00:00');
    ids.dstEnd = fixture('DST fim', 906, 'pago', '2018-11-05T01:59:59.999Z');
    ids.dstNext = fixture('DST dia seguinte', 907, 'pago', '2018-11-05 02:00:00');
    ids.repeatedTimeOne = fixture('Mesmo horário A', 910, 'pago', '2026-10-13 12:00:00');
    ids.repeatedTimeTwo = fixture('Mesmo horário B', 911, 'pago', '2026-10-13T12:00:00.000Z');
    ids.literalWildcard = fixture('Oferta 100% _ especial', 912, 'novo', '2026-10-08 12:00:00');
    ids.leapDay = fixture('Dia bissexto', 913, 'pago', '2024-02-29 15:00:00');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  await t.test('login is required and the default history includes online orders of every status', async () => {
    assert.equal((await api('/api/admin/sales-history', 'GET', undefined, '')).status, 401);
    const result = await history();
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.body.limit, 25); assert.equal(result.body.offset, 0);
    assert.ok(result.body.total > 200); assert.equal(result.body.orders.length, 25);
    assert.ok(result.body.orders.every(order => order.sales_channel === 'whatsapp'));
    for (const id of [ids.pending, ids.confirmed, ids.paid, ids.delivered, ids.cancelled]) {
      assert.ok(result.body.orders.some(order => order.id === id));
    }
    assert.ok(!result.body.orders.some(order => order.id === ids.counter));
  });

  await t.test('all pages can reach more than two hundred orders without duplicates', async () => {
    const first = (await history('limit=100')).body;
    const second = (await history('limit=100&offset=100')).body;
    const third = (await history('limit=100&offset=200')).body;
    const all = [...first.orders, ...second.orders, ...third.orders];
    assert.equal(all.length, first.total);
    assert.equal(new Set(all.map(order => order.id)).size, first.total);
    assert.ok(all.some(order => order.id === ids.leapDay));
    const times = all.map(order => Date.parse(order.created_at.includes('T') ? order.created_at : `${order.created_at.replace(' ', 'T')}Z`));
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1] >= times[i]);
      if (times[i - 1] === times[i]) assert.ok(all[i - 1].id > all[i].id);
    }
    assert.ok(all.findIndex(order => order.id === ids.repeatedTimeTwo) < all.findIndex(order => order.id === ids.repeatedTimeOne));
    const beyond = (await history('offset=99999')).body;
    assert.deepEqual(beyond.orders, []); assert.equal(beyond.offset, 99999); assert.equal(beyond.total, first.total);
    assert.deepEqual(beyond.summary, first.summary);
  });

  await t.test('summary covers the complete filtered set and recognizes only paid or delivered revenue', async () => {
    const query = 'from=2026-10-10&to=2026-10-10';
    const result = (await history(`${query}&limit=1`)).body;
    assert.equal(result.orders.length, 1);
    // BeforeStart is 23:59:59.999 on October 10 in São Paulo.
    assert.deepEqual(result.summary, { orders: 7, sales_orders: 4, sales_cents: 4600,
      pending_orders: 2, cancelled_orders: 1, average_ticket_cents: 1150 });
    assert.deepEqual((await history(`${query}&offset=3&limit=2`)).body.summary, result.summary);
    assert.deepEqual((await history(`${query}&channel=in_person`)).body.summary,
      { orders: 1, sales_orders: 1, sales_cents: 4500, pending_orders: 0, cancelled_orders: 0, average_ticket_cents: 4500 });
    const combined = (await history(`${query}&channel=all`)).body;
    assert.equal(combined.total, 8); assert.equal(combined.summary.sales_cents, 9100);
    assert.equal((await history('status=novo')).body.summary.sales_cents, 0);
    assert.equal((await history('status=cancelado')).body.summary.cancelled_orders, 1);
    assert.equal((await history('channel=in_person&status=entregue')).body.total, 0);
  });

  await t.test('local date limits include the whole day and respect historical São Paulo daylight saving', async () => {
    const day = (await history('from=2026-10-11&to=2026-10-11')).body;
    assert.deepEqual(day.orders.map(order => order.id), [ids.lastMillis, ids.atStart]);
    const dst = (await history('from=2018-11-04&to=2018-11-04')).body;
    assert.deepEqual(dst.orders.map(order => order.id), [ids.dstEnd, ids.dstStart]);
    assert.ok(!(await history('to=2018-11-03')).body.orders.some(order => order.id === ids.dstStart));
    assert.ok((await history(`from=2018-11-05&search=%23${ids.dstNext}`)).body.orders.some(order => order.id === ids.dstNext));
    assert.equal((await history('from=2024-02-29&to=2024-02-29')).body.total, 1);
    assert.equal((await history('to=9999-12-31')).body.total, (await history()).body.total);
  });

  await t.test('search accepts missing accents, phone fragments and an exact optional-hash order ID', async () => {
    assert.deepEqual((await history('search=JOSE%20AVILA')).body.orders.map(order => order.id), [ids.pending]);
    assert.deepEqual((await history('search=Jo%C3%A3o')).body.orders.map(order => order.id), [ids.paid]);
    assert.deepEqual((await history('search=981234')).body.orders.map(order => order.id), [ids.pending]);
    assert.deepEqual((await history(`search=%23${ids.counter}&channel=all`)).body.orders.map(order => order.id), [ids.counter]);
    assert.deepEqual((await history(`search=${ids.counter}&channel=in_person`)).body.orders.map(order => order.id), [ids.counter]);
    assert.deepEqual((await history('search=%25')).body.orders.map(order => order.id), [ids.literalWildcard]);
    assert.deepEqual((await history('search=_')).body.orders.map(order => order.id), [ids.literalWildcard]);
    assert.equal((await history(`search=${encodeURIComponent("' OR 1=1 --")}`)).body.total, 0);
    assert.equal((await history('search=sem%20resultado')).body.summary.average_ticket_cents, 0);
  });

  await t.test('invalid, repeated, nested, impossible and reversed query filters are rejected', async () => {
    for (const query of ['channel=site', 'channel=', 'channel=all&channel=whatsapp', 'status=pending',
      'status=pago&status=novo', 'search=one&search=two', 'search[x]=one', `search=${'a'.repeat(121)}`,
      'from=', 'to=', 'from=2026-02-29', 'to=2026-02-30', 'from=2026-13-01', 'from=0000-01-01',
      'from=2026-2-01', 'from=2026-10-11&to=2026-10-10', 'from=2026-10-10&from=2026-10-11',
      'limit=0', 'limit=101', 'limit=1.5', 'limit=abc', 'limit=1&limit=2', 'offset=-1', 'offset=1.2',
      'offset=9007199254740992', 'offset=', 'offset=1&offset=2', 'unknown=x']) {
      const result = await history(query);
      assert.equal(result.status, 400, query); assert.equal(typeof result.body.error, 'string');
    }
  });

  await t.test('history returns sold names, amounts and costs even after current products change', async () => {
    db.prepare('UPDATE products SET name=?,price_cents=?,cost_cents=?,stock_grams=? WHERE id=1')
      .run('Produto de hoje', 99900, 99900, 0);
    const paid = (await history(`search=%23${ids.paid}`)).body.orders[0];
    assert.equal(paid.items.length, 2); assert.equal(paid.items[0].name, 'Nome na venda');
    assert.equal(paid.items[0].price_cents, 1400); assert.equal(paid.items[0].cost_cents, 400);
    assert.equal(paid.items[0].weight_grams, 250); assert.equal(paid.items[0].stock_grams, 250);
    assert.equal(paid.profit.profit_cents, 1000);
    assert.equal((await history(`search=%23${ids.noCost}`)).body.orders[0].profit, null);
  });

  await t.test('new online and counter orders appear automatically in their respective histories', async () => {
    const created = await api('/api/admin/products', 'POST', { name: 'Produto novo do teste', price: 10,
      sale_unit: 'unit', stock_units: 20, cost: 4 });
    const productId = created.body.id;
    const items = [{ id: productId, sale_unit: 'unit', qty: 2 }];
    const online = await api('/api/orders', 'POST', { customer: 'Compra no site', items, expected_total_cents: 2000 });
    assert.equal(online.status, 200);
    const counter = await api('/api/admin/sales', 'POST', { request_id: randomUUID(), items,
      customer: 'Compra presencial', expected_total_cents: 2000, payment_method: 'pix' });
    assert.equal(counter.status, 200);
    assert.equal((await history(`search=%23${online.body.id}`)).body.orders[0].status, 'novo');
    assert.equal((await history(`search=%23${counter.body.id}`)).body.total, 0);
    assert.equal((await history(`search=%23${counter.body.id}&channel=in_person`)).body.orders[0].status, 'pago');
    const paid = await api(`/api/admin/orders/${online.body.id}`, 'PATCH', { status: 'pago' });
    assert.equal(paid.status, 200);
    assert.equal((await history(`search=%23${online.body.id}`)).body.summary.sales_cents, 2000);
  });

  await t.test('history queries never alter orders, items, product stocks or the inventory ledger', async () => {
    const snapshot = () => JSON.stringify(['products', 'orders', 'order_items', 'stock_movements', 'in_person_sale_requests']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'in_person_sale_requests' ? 'request_id' : 'id'}`).all()));
    const before = snapshot();
    await history(); await history('channel=all&limit=100&offset=200');
    await history('from=2018-11-04&to=2018-11-04'); await history('status=cancelado');
    await history('search=Jos%C3%A9'); await history('channel=in_person');
    assert.equal(snapshot(), before);
  });
});
