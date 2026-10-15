#!/usr/bin/env node
// Integration checks against the bundled Worker and real workerd SQLite storage.
// All databases and exports created here belong to an isolated temporary folder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = require('miniflare');
const { initializeDatabase } = require('../src/database-schema');
const { recordMovement } = require('../src/inventory');
const { portionPrice } = require('../shared/pricing');
const { promotionState, discountFor } = require('../src/promotions');
const { exportData, inspectFile, jsonLines } = require('./cloudflare-data.cjs');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.join(ROOT, 'artifacts', 'cloudflare-worker', 'worker.js');
const ASSETS = path.join(ROOT, 'artifacts', 'cloudflare-assets');
const ORIGIN = 'https://shop.example';
const WORKER = 'purograo-integration';
const OBJECT = 'puro-grao-store-v1';
const PASSWORD = 'integration-password-not-a-real-secret';
const IMPORT_TOKEN = 'integration-import-token-not-a-real-secret';
const hash = value => createHash('sha256').update(value).digest('hex');

async function bounded(label, operation, milliseconds = 30000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout after ${milliseconds} ms.`)), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function options(directory, password = PASSWORD) {
  return convertV4MiniflareOptions({
    name: WORKER, modules: true, scriptPath: BUNDLE,
    compatibilityDate: '2026-10-15', compatibilityFlags: ['nodejs_compat'],
    bindings: {
      ENVIRONMENT: 'production', PUBLIC_URL: ORIGIN, ADMIN_PASSWORD: password,
      IMPORT_TOKEN, WHATSAPP_NUMBER: '5585999999999',
      ORDER_RATE_MAX_NEW: '3', ORDER_RATE_MAX_ATTEMPTS: '6',
    },
    durableObjects: { SHOP_DB: { className: 'ShopDatabase', useSQLite: true } },
    assets: {
      directory: ASSETS, binding: 'ASSETS', run_worker_first: true,
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      assetConfig: { html_handling: 'none', not_found_handling: 'none' },
    },
    resourcePersistencePath: path.join(directory, 'storage'),
    unsafeInspectDurableObjects: true,
    cf: false, telemetry: { enabled: false }, log: new Log(LogLevel.ERROR), logRequests: false,
  });
}

function fixture(directory) {
  const filename = path.join(directory, 'fixture.db');
  const image = fs.readFileSync(path.join(ROOT, 'public', 'images', 'hero-natural.png'));
  assert.ok(image.length > 2 * 1024 * 1024, 'Fixture must exercise the Cloudflare row-size limit.');
  const db = new DatabaseSync(filename);
  try {
    initializeDatabase(db, { seed: false });
    const insert = db.prepare(`INSERT INTO products(id,name,description,price_cents,cost_cents,
      price_weight_grams,sale_unit,stock_grams,stock_units,category,active,display_order,tuesday_promo,
      image_data,image_mime,image_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const products = [
      [1, 'Amêndoas promoção', 'Porções a granel.', 1234, 700, 250, 'weight', 20000, 0, 'Castanhas', 1, 1, 1, image, 'image/png', hash(image)],
      [2, 'Óleo de coco', 'Venda por unidade.', 1500, 800, 1000, 'unit', 0, 20, 'Óleos', 1, 2, 0, null, '', ''],
      [3, 'Esgotado', '', 500, 100, 1000, 'unit', 0, 0, 'Geral', 1, 3, 0, null, '', ''],
      [4, 'Chá oculto', '', 1000, 500, 1000, 'weight', 20000, 0, 'Chás', 0, 4, 0, null, '', ''],
      [5, 'Granola básica', '', 1000, 500, 1000, 'weight', 100000, 0, 'Grãos', 1, 5, 0, null, '', ''],
    ];
    for (const product of products) insert.run(...product);
    for (const product of db.prepare('SELECT * FROM products').all()) {
      recordMovement(db, product, { delta: product.sale_unit === 'unit' ? product.stock_units : product.stock_grams,
        reason: 'initial', note: 'Synthetic integration fixture.' });
    }
    db.prepare('INSERT INTO kits(id,name,description,active,components) VALUES(?,?,?,?,?)')
      .run(1, 'Kit misto', 'Porção e unidade.', 1, JSON.stringify([
        { id: 1, weight_grams: 125, qty: 2 }, { id: 2, sale_unit: 'unit', weight_grams: 0, qty: 1 },
      ]));
    db.prepare('INSERT INTO site_banner(id,active,title,description,link_label,link_url) VALUES(1,1,?,?,?,?)')
      .run('Banner de integração', 'Produtos da fixture.', 'Ver ofertas', '/ofertas');
  } finally { db.close(); }
  return { filename, image };
}

async function main(argv = process.argv.slice(2)) {
  let sourceFile;
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--file') throw new Error('Use no arguments or --file <export.jsonl>.');
    sourceFile = path.resolve(argv[1]);
  }
  if (!fs.existsSync(BUNDLE) || !fs.existsSync(ASSETS)) {
    throw new Error('Run npm run check:cloudflare first to build the Worker and staged assets.');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-cloudflare-integration-'));
  let mf;
  let token = '';
  let checks = 0;
  const step = async (label, callback, timeout = 60000) => {
    await bounded(label, callback, timeout);
    console.log(`OK ${++checks}: ${label}`);
  };
  const start = async password => {
    mf = new Miniflare(options(directory, password));
    await bounded('Miniflare startup', () => mf.ready, 45000);
  };
  const stop = async () => {
    if (!mf) return;
    const current = mf;
    mf = undefined;
    await bounded('Miniflare shutdown', () => current.dispose(), 20000);
  };
  const dispatch = (route, init = {}) => bounded(`HTTP ${init.method || 'GET'} ${route}`, () => mf.dispatchFetch(
    route.startsWith('http') ? route : ORIGIN + route,
    // workerd closes local HTTP/1 connections after rejecting an unread POST.
    // Avoid reusing that socket for the next independent integration request.
    { redirect: 'manual', ...init, headers: { Connection: 'close', 'cf-connecting-ip': '203.0.113.10', ...init.headers } },
  ));
  const api = async (route, method = 'GET', body, extra = {}) => {
    const response = await dispatch(route, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'x-token': token } : {}), ...extra.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await bounded(`read JSON ${route}`, () => response.json());
    return { status: response.status, body: result, headers: response.headers };
  };
  const success = result => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const catalog = async () => success(await api('/api/products'));
  const products = async () => success(await api('/api/admin/products')).products;
  const product = async id => (await products()).find(item => item.id === id);
  const imageHash = async id => {
    const response = await dispatch(`/api/products/${id}/image`);
    assert.equal(response.status, 200);
    return hash(Buffer.from(await bounded('read product image', () => response.arrayBuffer())));
  };
  const migrate = async (operation, body, credential = IMPORT_TOKEN) => {
    const response = await dispatch(`/__migration/${operation}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await bounded('read migration response', () => response.json()) };
  };
  const securityHeaders = response => {
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
    assert.equal(response.headers.get('x-powered-by'), null);
  };
  try {
    let originalImage;
    if (!sourceFile) {
      const data = fixture(directory);
      originalImage = data.image;
      sourceFile = path.join(directory, 'fixture.jsonl');
      await exportData({ db: data.filename, out: sourceFile });
    }
    const manifest = await bounded('inspect export', () => inspectFile(sourceFile), 180000);
    await start();
    await step('staged pages, assets, HTTPS policy and migration gate', async () => {
      for (const route of ['/', '/admin', '/ofertas', '/shared/pricing.js', '/js/search.js']) {
        const response = await dispatch(route);
        if (response.status !== 200) {
          throw new Error(`${route}: HTTP ${response.status}; ${(await response.text()).slice(0, 800)}`);
        }
        securityHeaders(response);
        await response.arrayBuffer();
      }
      for (const route of ['/loja.db', '/src/database.js', '/cloudflare-data.jsonl', '/.env']) {
        const response = await dispatch(route);
        assert.equal(response.status, 404, route);
        await response.arrayBuffer();
      }
      assert.equal((await api('/api/products')).status, 503);
      const wrongHost = await dispatch('https://wrong.example/api/products');
      assert.equal(wrongHost.status, 421);
      await wrongHost.arrayBuffer();
      const plainPost = await dispatch('http://shop.example/api/admin/login', { method: 'POST',
        headers: { 'x-forwarded-proto': 'https' }, body: '{}' });
      assert.equal(plainPost.status, 426);
      await plainPost.arrayBuffer();
      // Miniflare's dispatchFetch currently follows redirects despite RequestInit.
      // Its local entry header preserves the same original URL without following.
      const runtime = await mf.ready;
      const redirect = await bounded('HTTP redirect', () => fetch(runtime, { redirect: 'manual',
        headers: { 'MF-Original-URL': 'http://shop.example/', 'MF-Disable-Pretty-Error': 'true' } }));
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get('location'), ORIGIN + '/');
      await redirect.arrayBuffer();
    });
    await step('authenticated import, row hashes, ready lock and complete image bytes', async () => {
      assert.equal((await migrate('status', undefined, 'wrong-token')).status, 401);
      assert.equal(success(await migrate('status')).ready, false);
      success(await migrate('begin', { manifest }));
      let rows = 0;
      for await (const entry of jsonLines(sourceFile)) {
        if (entry.type === 'manifest') continue;
        success(await migrate('row', { session: manifest.sha256, table: entry.table, row: entry.row }));
        rows++;
        if (argv.length && rows % 25 === 0) console.log(`Import progress: ${rows} rows.`);
      }
      const ready = success(await migrate('commit', { session: manifest.sha256 }));
      assert.equal(ready.ready, true);
      assert.equal(ready.session, manifest.sha256);
      assert.deepEqual(ready.counts, Object.fromEntries(manifest.tables.map(table => [table.name, table.count])));
      assert.equal((await migrate('begin', { manifest })).status, 409);
      let images = 0;
      for await (const entry of jsonLines(sourceFile)) {
        if (entry.table !== 'products' || !entry.row.image_data) continue;
        assert.equal(await imageHash(entry.row.id), entry.row.image_data.sha256, `Image ${entry.row.id}`);
        images++;
      }
      console.log(`Verified ${rows} imported rows and ${images} complete image hashes.`);
    }, argv.length ? 600000 : 120000);

    if (argv.length) {
      await step('real export remains available after runtime restart', async () => {
        await stop();
        await start();
        assert.equal(success(await migrate('status')).session, manifest.sha256);
        assert.ok(Array.isArray((await catalog()).products));
      });
      console.log(`Cloudflare real-export verification passed (${checks} groups).`);
      return;
    }

    await step('production HTTPS bridge, authentication, logout and trusted client IP', async () => {
      assert.equal((await api('/api/admin/products')).status, 401);
      const login = await api('/api/admin/login', 'POST', { password: PASSWORD }, {
        headers: { 'x-forwarded-proto': 'http', 'x-forwarded-for': '198.51.100.1', 'x-forwarded-host': 'wrong.example' },
      });
      token = success(login).token;
      assert.ok(token);
      securityHeaders(login);
      const second = success(await api('/api/admin/login', 'POST', { password: PASSWORD })).token;
      success(await api('/api/admin/logout', 'POST', undefined, { headers: { 'x-token': second } }));
      assert.equal((await api('/api/admin/products', 'GET', undefined, { headers: { 'x-token': second } })).status, 401);
      for (let index = 0; index < 5; index++) {
        assert.equal((await api('/api/admin/login', 'POST', { password: 'wrong' }, {
          headers: { 'cf-connecting-ip': '203.0.113.80', 'x-forwarded-for': `198.51.100.${index}` },
        })).status, 401);
      }
      assert.equal((await api('/api/admin/login', 'POST', { password: PASSWORD }, {
        headers: { 'cf-connecting-ip': '203.0.113.80', 'x-forwarded-for': '198.51.100.99' },
      })).status, 429);
      assert.equal((await api('/api/admin/login', 'POST', { password: 'wrong' }, {
        headers: { 'cf-connecting-ip': '203.0.113.81' },
      })).status, 401);
      assert.equal((await products()).length, 5);
    });

    let mixedTotal;
    let mixedOrder;
    await step('catalogue, kit, banner, accent search and shared pricing', async () => {
      const data = await catalog();
      assert.equal(data.products.length, 4);
      assert.ok(!data.products.some(item => item.id === 4));
      assert.equal(data.kits.length, 1);
      assert.equal(data.banner.title, 'Banner de integração');
      assert.equal(data.shipping.free_shipping_min_cents, 5000);
      const now = new Date(data.promotion.server_now);
      assert.equal(data.promotion.active, promotionState(now).active);
      const almond = data.products.find(item => item.id === 1);
      assert.equal(almond.discount_percent, discountFor(almond, promotionState(now)));
      const source = await dispatch('/js/search.js');
      const context = {};
      vm.runInNewContext(await source.text(), context);
      assert.equal(context.ProductSearch.matches(almond, 'amendoas'), true);
      const priceSource = await dispatch('/shared/pricing.js');
      vm.runInNewContext(await priceSource.text(), context);
      const expected = portionPrice(almond, 125);
      assert.equal(context.PuroPricing.portionPrice(almond, 125), expected);
      mixedTotal = expected * 2 + 1500 * 2;
      assert.equal(await imageHash(1), hash(originalImage));
    });
    await step('weighted quantities, server totals, stock lifecycle and shipping threshold', async () => {
      const body = { request_id: randomUUID(), customer: 'José São João', expected_total_cents: mixedTotal,
        items: [{ id: 1, weight_grams: 125, qty: 2 }, { id: 2, sale_unit: 'unit', qty: 2 }] };
      const placed = success(await api('/api/orders', 'POST', body));
      mixedOrder = placed.id;
      assert.equal(placed.total_cents, mixedTotal);
      assert.equal(new URL(placed.whatsapp_url).hostname, 'wa.me');
      assert.equal((await product(1)).stock_grams, 20000);
      assert.equal(success(await api('/api/orders', 'POST', body)).duplicate, true);
      success(await api(`/api/admin/orders/${mixedOrder}`, 'PATCH', { status: 'confirmado' }));
      assert.equal((await product(1)).stock_grams, 19750);
      assert.equal((await product(2)).stock_units, 18);
      success(await api(`/api/admin/orders/${mixedOrder}`, 'PATCH', { status: 'pago' }));
      assert.equal((await product(1)).stock_grams, 19750);
      success(await api(`/api/admin/orders/${mixedOrder}`, 'PATCH', { status: 'cancelado' }));
      success(await api(`/api/admin/orders/${mixedOrder}`, 'PATCH', { status: 'cancelado' }));
      assert.equal((await product(1)).stock_grams, 20000);
      assert.equal((await product(2)).stock_units, 20);
      for (const [grams, total, free, ip] of [[4900, 4900, false, '203.0.113.21'], [5000, 5000, true, '203.0.113.22']]) {
        const shipping = success(await api('/api/orders', 'POST', {
          request_id: randomUUID(), customer: 'Entrega', delivery_method: 'delivery',
          delivery_city: 'Maracanaú', address: 'Rua de teste', expected_total_cents: total,
          items: [{ id: 5, weight_grams: grams, qty: 1 }],
        }, { headers: { 'cf-connecting-ip': ip } }));
        assert.equal(shipping.shipping.free, free);
      }
      assert.equal((await api('/api/orders', 'POST', {
        customer: 'Esgotado', items: [{ id: 3, sale_unit: 'unit', qty: 1 }],
      }, { headers: { 'cf-connecting-ip': '203.0.113.23' } })).status, 409);
    });

    await step('POS atomic stock rollback, idempotency, sales search and dashboard', async () => {
      const before = await product(1);
      const failed = await api('/api/admin/sales', 'POST', {
        request_id: randomUUID(), payment_method: 'pix', expected_total_cents: mixedTotal,
        items: [{ id: 1, weight_grams: 125, qty: 2 }, { id: 3, sale_unit: 'unit', qty: 1 }],
      });
      assert.equal(failed.status, 409);
      assert.equal((await product(1)).stock_grams, before.stock_grams);
      const body = { request_id: randomUUID(), customer: 'José São João', payment_method: 'pix',
        expected_total_cents: mixedTotal,
        items: [{ id: 1, weight_grams: 125, qty: 2 }, { id: 2, sale_unit: 'unit', qty: 2 }] };
      const results = await Promise.all([api('/api/admin/sales', 'POST', body), api('/api/admin/sales', 'POST', body)]);
      const sales = results.map(success);
      assert.equal(sales[0].id, sales[1].id);
      assert.deepEqual(sales.map(sale => sale.duplicate).sort(), [false, true]);
      assert.equal((await product(1)).stock_grams, 19750);
      assert.equal((await product(2)).stock_units, 18);
      const history = success(await api('/api/admin/sales-history?search=jose&channel=all'));
      assert.ok(history.orders.some(order => order.id === sales[0].id));
      const dashboard = success(await api('/api/admin/dashboard'));
      assert.equal(dashboard.timezone, 'America/Sao_Paulo');
      assert.equal(dashboard.day.sales_cents, mixedTotal);
      assert.equal(dashboard.day.sales_orders, 1);
      assert.ok(dashboard.stock.sold_out >= 1);
    });

    await step('large image editor and SQL failure roll back image, stock and chunks', async () => {
      const replacement = fs.readFileSync(path.join(ROOT, 'public', 'images', 'Terça do Granel_ Chá Natural em Destaque.png'));
      assert.ok(replacement.length > 2 * 1024 * 1024);
      const edit = current => ({ name: current.name, description: current.description, category: current.category,
        price: current.price_cents / 100, cost: current.cost_cents / 100,
        price_weight_grams: current.price_weight_grams, stock_grams: current.stock_grams,
        sale_unit: current.sale_unit, active: Boolean(current.active), color: current.color,
        tuesday_promo: Boolean(current.tuesday_promo), is_new: Boolean(current.is_new) });
      success(await api('/api/admin/products/1', 'PUT', { ...edit(await product(1)),
        image_data_url: `data:image/png;base64,${replacement.toString('base64')}`,
        image_position_x: 17, image_position_y: 83, image_fit: 'contain' }));
      assert.equal(await imageHash(1), hash(replacement));
      const saved = await product(1);
      assert.equal(saved.image_position_x, 17);
      assert.equal(saved.image_position_y, 83);
      assert.equal(saved.image_fit, 'contain');
      const storage = await mf.unsafeGetDurableObjectStorage(WORKER, 'ShopDatabase', { name: OBJECT });
      const before = await storage.exec('SELECT COUNT(*) AS count FROM __puro_blob_chunks');
      await storage.exec(`CREATE TRIGGER integration_fail_movement BEFORE INSERT ON stock_movements
        WHEN NEW.product_id=1 AND NEW.reason='product_edit'
        BEGIN SELECT RAISE(ABORT, 'integration rollback'); END`);
      try {
        const failed = await api('/api/admin/products/1', 'PUT', { ...edit(saved), stock_grams: saved.stock_grams + 1,
          image_data_url: `data:image/png;base64,${originalImage.toString('base64')}` });
        assert.equal(failed.status, 500);
        assert.equal((await product(1)).stock_grams, saved.stock_grams);
        assert.equal(await imageHash(1), hash(replacement));
        assert.deepEqual(await storage.exec('SELECT COUNT(*) AS count FROM __puro_blob_chunks'), before);
      } finally { await storage.exec('DROP TRIGGER integration_fail_movement'); }
    }, 120000);

    await step('persistent request limits trust edge IP and reject forwarded-IP changes', async () => {
      for (let index = 0; index < 6; index++) {
        assert.equal((await api('/api/orders', 'POST', {}, { headers: {
          'cf-connecting-ip': '203.0.113.70', 'x-forwarded-for': `198.51.100.${index}`,
        } })).status, 400);
      }
      assert.equal((await api('/api/orders', 'POST', {}, { headers: {
        'cf-connecting-ip': '203.0.113.70', 'x-forwarded-for': '198.51.100.99',
      } })).status, 429);
      assert.equal((await api('/api/orders', 'POST', {}, { headers: { 'cf-connecting-ip': '203.0.113.71' } })).status, 400);
      for (let index = 0; index < 3; index++) success(await api('/api/orders', 'POST', {
        request_id: randomUUID(), customer: 'Creation limiter', items: [{ id: 5, weight_grams: 1, qty: 1 }],
      }, { headers: { 'cf-connecting-ip': '203.0.113.72' } }));
      assert.equal((await api('/api/orders', 'POST', {
        customer: 'Limited', items: [{ id: 5, weight_grams: 1, qty: 1 }],
      }, { headers: { 'cf-connecting-ip': '203.0.113.72' } })).status, 429);
    });

    await step('Durable Object eviction, isolation and runtime restart preserve data and auth', async () => {
      const state = await products();
      const photo = await imageHash(1);
      const namespace = await mf.getDurableObjectNamespace('SHOP_DB');
      const isolated = namespace.get(namespace.idFromName('integration-other-store'));
      const response = await bounded('second Durable Object', () => isolated.fetch(ORIGIN + '/api/products'));
      assert.equal(response.status, 503);
      await response.arrayBuffer();
      await mf.unsafeEvictDurableObject(WORKER, 'ShopDatabase', { name: OBJECT });
      assert.deepEqual(await products(), state);
      await stop();
      await start();
      assert.deepEqual(await products(), state);
      assert.equal(await imageHash(1), photo);
      assert.equal((await api('/api/admin/login', 'POST', { password: PASSWORD }, {
        headers: { 'cf-connecting-ip': '203.0.113.80' },
      })).status, 429);
      assert.equal((await api('/api/orders', 'POST', {}, {
        headers: { 'cf-connecting-ip': '203.0.113.70' },
      })).status, 429);
      assert.equal((await api('/api/orders', 'POST', {
        customer: 'Limited', items: [{ id: 5, weight_grams: 1, qty: 1 }],
      }, { headers: { 'cf-connecting-ip': '203.0.113.72' } })).status, 429);
    }, 120000);
    await step('changing administrator password revokes prior persistent sessions', async () => {
      await stop();
      const changed = PASSWORD + '-changed';
      await start(changed);
      assert.equal((await api('/api/admin/products')).status, 401);
      token = success(await api('/api/admin/login', 'POST', { password: changed })).token;
      assert.equal((await products()).length, 5);
    });
  } finally {
    await stop();
    const resolved = path.resolve(directory);
    const tempRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), tempRoot, 'Refuse to remove an unexpected temporary path.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log(`Cloudflare integration passed (${checks} groups).`);
}

if (require.main === module) main().catch(error => {
  console.error(`Cloudflare integration failed: ${error.stack || error.message}`);
  if (error.cause) console.error('Underlying error:', error.cause);
  process.exitCode = 1;
});
module.exports = { main };
