const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrderLimits } = require('../src/order-limits');

test('order limits bound attempts, successful creations, memory and window lifetime', () => {
  let time = 0;
  const limits = createOrderLimits({ windowMs: 900000, maxNew: 10, maxAttempts: 30, maxIps: 2, clock: () => time });
  const attempt = ip => {
    const result = { next: false, headers: {} };
    const response = { set: (key, value) => { result.headers[key] = value; },
      status: value => { result.status = value; return response; }, json: body => { result.body = body; } };
    limits.attempt({ ip }, response, () => { result.next = true; });
    return result;
  };
  for (let i = 0; i < 10; i++) {
    assert.equal(attempt('one').next, true); limits.assertCreation('one'); limits.recordCreation('one');
  }
  assert.throws(() => limits.assertCreation('one'), error => error.status === 429 && error.retry_after_seconds === 900);
  for (let i = 0; i < 20; i++) assert.equal(attempt('one').next, true, 'Retries use attempts but do not create orders');
  assert.equal(attempt('one').status, 429);
  assert.equal(attempt('two').next, true); assert.equal(limits.trackedIps(), 2);
  assert.equal(attempt('three').status, 429); assert.equal(limits.trackedIps(), 2);
  time = 900000;
  assert.equal(attempt('three').next, true); assert.equal(limits.trackedIps(), 1);
  assert.equal(attempt('one').next, true); assert.doesNotThrow(() => limits.assertCreation('one'));
});

test('public orders cannot reserve inventory anonymously and retries retain their original order', async t => {
  const auditTempRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(auditTempRoot, 'puro-public-security-'));
  assert.ok(fs.realpathSync(directory).startsWith(auditTempRoot + path.sep));
  process.env.DB_FILE = path.join(directory, 'test.db');
  process.env.ADMIN_PASSWORD = 'public-security-test-password';
  process.env.ORDER_RATE_MAX_NEW = '1000';
  process.env.ORDER_RATE_MAX_ATTEMPTS = '5000';
  const { db } = require('../src/database');
  const server = require('../src/app').createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (url, method = 'GET', body, auth = token) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-token': auth },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const token = (await api('/api/admin/login', 'POST', { password: 'public-security-test-password' }, '')).body.token;
  const create = async fields => {
    const result = await api('/api/admin/products', 'POST', fields); assert.equal(result.status, 200); return result.body.id;
  };
  const weightProduct = fields => create({ name: 'Produto a granel', price: 49, price_weight_grams: 1000, stock_grams: 20000, cost: 28, ...fields });
  const unitProduct = fields => create({ name: 'Produto por unidade', price: 45, sale_unit: 'unit', stock_units: 20, cost: 20, ...fields });
  const submit = body => api('/api/orders', 'POST', body, '');
  const body = (items, total, extra = {}) => ({ request_id: randomUUID(), customer: 'Cliente do teste', items, expected_total_cents: total, ...extra });
  const change = (id, status) => api(`/api/admin/orders/${id}`, 'PATCH', { status });
  const stock = id => db.prepare('SELECT stock_grams,stock_units FROM products WHERE id=?').get(id);
  const saved = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const history = id => db.prepare('SELECT * FROM stock_movements WHERE order_id=? ORDER BY id').all(id);
  const counts = () => ['orders', 'order_items', 'stock_movements', 'public_order_requests'].map(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

  await t.test('pending mixed orders keep stock intact and staff confirmation deducts each measure once', async () => {
    const weight = await weightProduct(), unit = await unitProduct();
    const placed = await submit(body([{ id: weight, weight_grams: 250, qty: 2 }, { id: unit, sale_unit: 'unit', qty: 2 }], 11450));
    assert.equal(placed.status, 200); assert.equal(saved(placed.body.id).status, 'novo');
    assert.equal(saved(placed.body.id).stock_deducted, 0);
    assert.equal(stock(weight).stock_grams, 20000); assert.equal(stock(unit).stock_units, 20); assert.deepEqual(history(placed.body.id), []);
    assert.deepEqual(db.prepare('SELECT stock_grams,stock_units,cost_cents FROM order_items WHERE order_id=? ORDER BY id').all(placed.body.id)
      .map(item => [item.stock_grams, item.stock_units, item.cost_cents]), [[500, 0, 700], [0, 2, 2000]]);
    assert.equal((await change(placed.body.id, 'novo')).status, 200); assert.equal(stock(unit).stock_units, 20);
    for (const status of ['confirmado', 'confirmado', 'pago', 'entregue', 'novo']) assert.equal((await change(placed.body.id, status)).status, 200);
    assert.equal(stock(weight).stock_grams, 19500); assert.equal(stock(unit).stock_units, 18);
    assert.equal(saved(placed.body.id).stock_deducted, 1);
    assert.deepEqual(history(placed.body.id).map(item => [item.reason, item.delta]), [['sale', -500], ['sale', -2]]);
    await change(placed.body.id, 'cancelado'); await change(placed.body.id, 'cancelado');
    assert.equal(stock(weight).stock_grams, 20000); assert.equal(stock(unit).stock_units, 20);
    await change(placed.body.id, 'novo'); assert.equal(stock(unit).stock_units, 20);
    await change(placed.body.id, 'confirmado'); assert.equal(stock(unit).stock_units, 18);
    assert.equal(history(placed.body.id).filter(item => item.reason === 'reopening').length, 0, 'The order was reopened as pending before confirmation');
  });

  await t.test('cancelling unconfirmed orders never returns stock and quoted prices/costs survive later edits', async () => {
    const id = await unitProduct();
    const request = body([{ id, sale_unit: 'unit', qty: 2 }], 9000);
    const placed = await submit(request);
    await change(placed.body.id, 'cancelado'); assert.equal(stock(id).stock_units, 20); assert.deepEqual(history(placed.body.id), []);
    assert.equal((await submit(request)).body.code, 'ORDER_REQUEST_CANCELLED');
    db.prepare('UPDATE products SET price_cents=9900,cost_cents=1 WHERE id=?').run(id);
    await change(placed.body.id, 'novo'); assert.equal(stock(id).stock_units, 20);
    assert.equal((await change(placed.body.id, 'pago')).status, 200); assert.equal(stock(id).stock_units, 18);
    const item = db.prepare('SELECT price_cents,cost_cents FROM order_items WHERE order_id=?').get(placed.body.id);
    assert.equal(item.price_cents, 4500); assert.equal(item.cost_cents, 2000); assert.equal(saved(placed.body.id).total_cents, 9000);
  });

  await t.test('simultaneous pending submissions do not reserve the last unit; confirmation cannot oversell', async () => {
    const id = await unitProduct({ stock_units: 1 });
    const results = await Promise.all(Array.from({ length: 8 }, () => submit(body([{ id, sale_unit: 'unit', qty: 1 }], 4500))));
    assert.ok(results.every(result => result.status === 200)); assert.equal(stock(id).stock_units, 1);
    const confirmed = await Promise.all(results.map(result => change(result.body.id, 'confirmado')));
    assert.deepEqual(confirmed.map(result => result.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
    assert.equal(stock(id).stock_units, 0);
    for (let i = 0; i < results.length; i++) if (confirmed[i].status === 409) {
      assert.equal(saved(results[i].body.id).stock_deducted, 0); assert.equal(saved(results[i].body.id).status, 'novo');
      assert.deepEqual(history(results[i].body.id), []);
    }
  });

  await t.test('insufficient mixed confirmation or failed ledger writes roll back the entire deduction', async () => {
    const weight = await weightProduct(), unit = await unitProduct();
    const placed = await submit(body([{ id: weight, weight_grams: 250, qty: 1 }, { id: unit, sale_unit: 'unit', qty: 2 }], 10225));
    db.prepare('UPDATE products SET stock_units=1 WHERE id=?').run(unit);
    assert.equal((await change(placed.body.id, 'pago')).status, 409);
    assert.equal(stock(weight).stock_grams, 20000); assert.equal(stock(unit).stock_units, 1);
    assert.equal(saved(placed.body.id).stock_deducted, 0); assert.deepEqual(history(placed.body.id), []);
    db.prepare('UPDATE products SET stock_units=20 WHERE id=?').run(unit);
    db.exec("CREATE TRIGGER fail_public_confirmation BEFORE INSERT ON stock_movements WHEN NEW.reason='sale' BEGIN SELECT RAISE(ABORT,'test confirmation rollback'); END;");
    try {
      assert.equal((await change(placed.body.id, 'pago')).status, 500);
      assert.equal(stock(weight).stock_grams, 20000); assert.equal(stock(unit).stock_units, 20);
      assert.equal(saved(placed.body.id).stock_deducted, 0); assert.deepEqual(history(placed.body.id), []);
    } finally { db.exec('DROP TRIGGER fail_public_confirmation'); }
    assert.equal((await change(placed.body.id, 'pago')).status, 200);
  });

  await t.test('UUID retries preserve original quotes through price changes, exhaustion, hidden products and reordered lines', async () => {
    const id = await weightProduct();
    const request = body([{ id, weight_grams: 250, qty: 1 }, { id, weight_grams: 250, qty: 2 }, { id, weight_grams: 500, qty: 1 }], 6125);
    const first = await submit(request); assert.equal(first.status, 200); const before = counts();
    db.prepare('UPDATE products SET active=0,price_cents=1,stock_grams=0 WHERE id=?').run(id);
    const replay = await submit({ ...request, request_id: request.request_id.toUpperCase(),
      items: [{ id, weight_grams: 500, qty: 1 }, { id, weight_grams: 250, qty: 3 }] });
    assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true); assert.equal(replay.body.id, first.body.id);
    assert.equal(replay.body.total_cents, first.body.total_cents); assert.equal(replay.body.whatsapp_url, first.body.whatsapp_url);
    assert.deepEqual(counts(), before);
    const conflict = await submit({ ...request, customer: 'Outro nome' });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'ORDER_REQUEST_CONFLICT');
    assert.equal((await submit({ ...request, expected_total_cents: 1 })).status, 409);
  });

  await t.test('deleted pending order IDs cannot be reused by public or counter orders', async () => {
    const id = await unitProduct();
    const request = body([{ id, sale_unit: 'unit', qty: 1 }], 4500);
    const first = await submit(request); assert.equal(first.status, 200);
    assert.equal((await api(`/api/admin/orders/${first.body.id}`, 'DELETE')).status, 200);
    assert.equal(db.prepare('SELECT response_json FROM public_order_requests WHERE request_id=?').get(request.request_id).response_json, '{}');
    const before = counts(); const deleted = await submit(request);
    assert.equal(deleted.status, 409); assert.equal(deleted.body.code, 'ORDER_REQUEST_DELETED'); assert.deepEqual(counts(), before);
    const next = await api('/api/admin/sales', 'POST', { request_id: randomUUID(), items: request.items,
      expected_total_cents: 4500, payment_method: 'pix' });
    assert.equal(next.status, 200); assert.ok(next.body.id > first.body.id);
    assert.equal((await submit(request)).body.code, 'ORDER_REQUEST_DELETED');
    assert.equal((await submit(body(request.items, 4500))).status, 200);
  });

  await t.test('legacy requests without a client UUID also retain their deleted order IDs without deduplicating new purchases', async () => {
    const id = await unitProduct();
    const request = { customer: 'Cliente legado', items: [{ id, sale_unit: 'unit', qty: 1 }] };
    const first = await submit(request); assert.equal(first.status, 200);
    assert.equal(Object.hasOwn(first.body, 'request_id'), false);
    assert.equal((await api(`/api/admin/orders/${first.body.id}`, 'DELETE')).status, 200);
    const second = await submit(request); assert.equal(second.status, 200);
    assert.ok(second.body.id > first.body.id, 'Deleted legacy identifiers must never be reused');
    const third = await submit(request); assert.equal(third.status, 200);
    assert.ok(third.body.id > second.body.id, 'Identical legacy requests still represent separate purchases');
    assert.equal(second.body.duplicate, false); assert.equal(third.body.duplicate, false);
    assert.equal(stock(id).stock_units, 20);
  });

  await t.test('bad UUIDs, aggregate unavailable portions and stale totals never create a pending order', async () => {
    const id = await weightProduct({ stock_grams: 300 });
    const request = body([{ id, weight_grams: 250, qty: 1 }], 1225);
    const before = counts();
    for (const request_id of ['', null, false, 'not-a-uuid']) assert.equal((await submit({ ...request, request_id })).status, 400);
    assert.equal((await submit({ ...request, items: [{ id, weight_grams: 100, qty: 1 }, { id, weight_grams: 250, qty: 1 }] })).status, 409);
    assert.equal((await submit({ ...request, expected_total_cents: 1 })).status, 409);
    assert.deepEqual(counts(), before); assert.equal(stock(id).stock_grams, 300);
    const legacy = await submit({ customer: 'Cliente legado', items: request.items });
    assert.equal(legacy.status, 200); assert.equal(stock(id).stock_grams, 300);
  });

  await t.test('failed idempotency persistence rolls back all snapshots and a retry can then succeed', async () => {
    const id = await unitProduct(), request = body([{ id, sale_unit: 'unit', qty: 1 }], 4500);
    const before = counts();
    db.exec("CREATE TRIGGER fail_public_request BEFORE INSERT ON public_order_requests BEGIN SELECT RAISE(ABORT,'test request rollback'); END;");
    try { assert.equal((await submit(request)).status, 500); assert.deepEqual(counts(), before); }
    finally { db.exec('DROP TRIGGER fail_public_request'); }
    assert.equal(stock(id).stock_units, 20); assert.equal((await submit(request)).status, 200);
  });

  await t.test('HTTP limits count creations separately from retries and cannot be bypassed with forwarded IP headers', () => {
    const probe = `const {db}=require('./src/database');
      db.prepare("INSERT INTO products(id,name,price_cents,sale_unit,stock_units) VALUES(99,'Fixture',4500,'unit',20)").run();
      const server=require('./src/app').createApp().listen(0,'127.0.0.1');
      (async()=>{try {await new Promise(resolve=>server.once('listening',resolve));
        const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222',third='33333333-3333-4333-8333-333333333333';
        const results=[];for(const request_id of [first,first,second,third,first]){
          const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json','X-Forwarded-For':String(results.length)+'.1.1.1'},
            body:JSON.stringify({request_id,customer:'Fixture',items:[{id:99,sale_unit:'unit',qty:1}],expected_total_cents:4500})});
          results.push({status:response.status,retry:response.headers.get('retry-after'),body:await response.json()});}
        console.log(JSON.stringify({results,count:db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,stock:db.prepare('SELECT stock_units FROM products WHERE id=99').get().stock_units}));
      }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}})().catch(error=>{console.error(error);process.exitCode=1;});`;
    const result = spawnSync(process.execPath, ['-e', probe], { cwd: path.join(__dirname, '..'), windowsHide: true, encoding: 'utf8',
      env: { ...process.env, DB_FILE: path.join(directory, 'rate.db'), ORDER_RATE_MAX_NEW: '2', ORDER_RATE_MAX_ATTEMPTS: '4' } });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.results.map(value => value.status), [200, 200, 200, 429, 429]);
    assert.equal(output.results[1].body.duplicate, true); assert.ok(Number(output.results[3].retry) > 0);
    assert.equal(output.count, 2); assert.equal(output.stock, 20);
  });
});
