const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { DatabaseSync } = require('node:sqlite');
const { initializeDatabase } = require('../src/database-schema');
const { StorageDatabase, BLOB_CHUNK_BYTES } = require('../cloudflare/sqlite-adapter.cjs');
const { createImporter, createManifest, encodeRow, rowKeys, KEYS, sha256, canonical } = require('../cloudflare/importer.cjs');
const { exportData, importData, inspectFile, jsonLines, destination, assertSafeOutput, readImportToken } = require('../scripts/cloudflare-data.cjs');
const TOKEN = 'synthetic-import-token-for-tests';

function source(t, filename = ':memory:') {
  const db = new DatabaseSync(filename);
  initializeDatabase(db, { seed: false });
  const photograph = Buffer.from(Uint8Array.from({ length: BLOB_CHUNK_BYTES * 2 + 19 }, (_, index) => index % 251));
  db.prepare('INSERT INTO products(id,name,price_cents,image_data,image_mime) VALUES(?,?,?,?,?)')
    .run(7, 'Produto sintético', 1990, photograph, 'image/png');
  db.prepare('INSERT INTO products(id,name,price_cents,image_data) VALUES(?,?,?,?)').run(9, 'Foto pequena', 100, Buffer.from([0, 1, 2, 254, 255]));
  db.prepare('INSERT INTO orders(id,customer,total_cents) VALUES(?,?,?)').run(4, 'Cliente sintético', 1990);
  db.prepare('INSERT INTO order_items(id,order_id,product_id,name,qty,price_cents) VALUES(?,?,?,?,?,?)').run(2, 4, 7, 'Produto sintético', 1, 1990);
  db.prepare('INSERT INTO kits(id,name,components) VALUES(?,?,?)').run(3, 'Kit sintético', '[]');
  db.prepare('INSERT INTO site_banner(id,title) VALUES(?,?)').run(1, 'Banner sintético');
  db.prepare('INSERT INTO stock_movements(id,product_id,product_name,sale_unit,delta,balance,reason) VALUES(?,?,?,?,?,?,?)')
    .run(12, 7, 'Produto sintético', 'weight', 1000, 1000, 'initial');
  db.prepare('INSERT INTO stock_movements(id,product_id,product_name,sale_unit,delta,balance,reason) VALUES(?,?,?,?,?,?,?)')
    .run(500, 7, 'Removido', 'weight', 0, 1000, 'manual_adjustment');
  db.prepare('DELETE FROM stock_movements WHERE id=?').run(500);
  db.prepare('INSERT INTO in_person_sale_requests(request_id,request_hash,order_id,total_cents) VALUES(?,?,?,?)').run('local-synthetic', 'hash', 4, 1990);
  db.prepare('INSERT INTO public_order_requests(request_id,request_hash,order_id,response_json) VALUES(?,?,?,?)').run('public-synthetic', 'hash', 4, '{}');
  t.after(() => db.close());
  return { db, photograph };
}
function target(t) {
  const native = new DatabaseSync(':memory:');
  const storage = {
    failReceipt: false,
    sql: { exec(sql, ...bindings) {
      if (storage.failReceipt && /^INSERT INTO __puro_migration/.test(sql) && String(bindings[0]).startsWith('row:')) throw new Error('Synthetic receipt failure');
      const script = !bindings.length && /;\s*\S/.test(sql.trim().replace(/;$/, ''));
      let rows;
      if (script) { native.exec(sql); rows = []; }
      else rows = native.prepare(sql).all(...bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      // Cloudflare returns small BLOBs as ArrayBuffers, unlike node:sqlite.
      rows = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
        [key, value instanceof Uint8Array ? Uint8Array.from(value).buffer : value])));
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      native.exec('BEGIN IMMEDIATE');
      try { const result = callback(); native.exec('COMMIT'); return result; }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    }
  };
  const db = new StorageDatabase(storage);
  initializeDatabase(db, { seed: false });
  const importer = createImporter(db);
  t.after(() => native.close());
  return { db, native, storage, importer };
}
function entries(db, manifest) {
  return manifest.tables.flatMap(table => rowKeys(db, table.name).map(key => ({
    session: manifest.sha256, table: table.name,
    row: encodeRow(db.prepare(`SELECT * FROM ${table.name} WHERE ${KEYS[table.name]} = ?`).get(key[KEYS[table.name]]), table.columns)
  })));
}
async function request(importer, route, body, token = TOKEN) {
  return importer.handle(new Request(`https://synthetic.example/__migration/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), TOKEN);
}
async function upload(importer, sourceDb, manifest = createManifest(sourceDb)) {
  assert.equal((await request(importer, 'begin', { manifest })).status, 200);
  for (const entry of entries(sourceDb, manifest)) assert.equal((await request(importer, 'row', entry)).status, 200);
  return manifest;
}
function cleanDirectoryAfter(t, dir) {
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(dir).startsWith('puro-cloudflare-import-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('token is mandatory; disabled importer is 404 and wrong credentials reveal no metadata', async t => {
  const { importer, db } = target(t);
  const req = new Request('https://synthetic.example/__migration/status');
  assert.equal((await importer.handle(req, '')).status, 404);
  assert.equal((await request(importer, 'status', undefined, 'wrong')).status, 401);
  assert.equal((await request(importer, 'status')).status, 200);
  assert.equal(importer.isReady(), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM __puro_migration').get().count, 0);
});

test('CLI asks for a hidden token only in a terminal and restores terminal input', async t => {
  const previous = process.env.IMPORT_TOKEN;
  delete process.env.IMPORT_TOKEN;
  t.after(() => { if (previous === undefined) delete process.env.IMPORT_TOKEN; else process.env.IMPORT_TOKEN = previous; });
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  const rawModes = [];
  input.setRawMode = raw => { rawModes.push(raw); input.isRaw = raw; };
  const output = new PassThrough();
  let displayed = '';
  output.on('data', bytes => { displayed += bytes.toString(); });
  const pending = readImportToken(input, output);
  input.emit('keypress', TOKEN, {});
  input.emit('keypress', '\r', { name: 'return' });
  assert.equal(await pending, TOKEN);
  assert.equal(displayed.includes(TOKEN), false);
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(input.isPaused(), true);
  await assert.rejects(readImportToken(new PassThrough(), output), /terminal/);
  input.destroy();
  output.destroy();
});

test('manifest schema and fixed table list are enforced before accepting a session', async t => {
  const { db: original } = source(t);
  const { importer } = target(t);
  const manifest = createManifest(original);
  const invalid = structuredClone(manifest);
  invalid.tables[0].columns[0].name = 'injected_column';
  invalid.sha256 = sha256(canonical({ format: invalid.format, tables: invalid.tables }));
  assert.equal((await request(importer, 'begin', { manifest: invalid })).status, 400);
  const extra = structuredClone(manifest);
  extra.tables.push({ name: 'sqlite_master' });
  assert.equal((await request(importer, 'begin', { manifest: extra })).status, 400);
  assert.equal((await request(importer, 'row', { session: manifest.sha256, table: 'products; DROP TABLE products', row: {} })).status, 400);
  assert.equal(importer.isReady(), false);
});

test('equivalent schemas accept columns appended in a different physical order by older migrations', async t => {
  const { db: original, photograph } = source(t);
  for (const table of ['products', 'orders']) {
    const columns = original.prepare(`PRAGMA table_info(${table})`).all().reverse();
    const names = columns.map(column => column.name).join(', ');
    const declarations = columns.map(column => `${column.name} ${column.type}${column.notnull ? ' NOT NULL' : ''}${column.pk ? ' PRIMARY KEY' : ''}`).join(', ');
    original.exec(`ALTER TABLE ${table} RENAME TO previous_${table};
      CREATE TABLE ${table} (${declarations});
      INSERT INTO ${table} (${names}) SELECT ${names} FROM previous_${table};
      DROP TABLE previous_${table};`);
  }
  const { importer, db } = target(t);
  const manifest = createManifest(original);
  assert.notDeepEqual(manifest.tables[0].columns.map(column => column.name), db.prepare('PRAGMA table_info(products)').all().map(column => column.name));
  await upload(importer, original, manifest);
  assert.equal((await request(importer, 'commit', { session: manifest.sha256 })).status, 200);
  assert.equal(importer.isReady(), true);
  assert.equal(db.prepare('SELECT name FROM products WHERE id=?').get(7).name, 'Produto sintético');
  assert.equal(db.prepare('SELECT customer FROM orders WHERE id=?').get(4).customer, 'Cliente sintético');
  assert.deepEqual(Buffer.from(db.prepare('SELECT image_data FROM products WHERE id=?').get(7).image_data), photograph);
});

test('receipts make row retries idempotent and different content conflicts without replacing data', async t => {
  const { db: original } = source(t);
  const { importer, db } = target(t);
  const manifest = createManifest(original);
  await request(importer, 'begin', { manifest });
  const entry = entries(original, manifest)[0];
  assert.equal((await request(importer, 'row', entry)).status, 200);
  const repeated = await request(importer, 'row', entry);
  assert.deepEqual(await repeated.json(), { accepted: true, duplicate: true });
  assert.equal((await request(importer, 'row', { ...entry, row: { ...entry.row, name: 'Conteúdo diferente' } })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM products').get().count, 1);
  assert.equal(db.prepare('SELECT name FROM products WHERE id=?').get(7).name, 'Produto sintético');
});

test('row and receipt roll back together, including image chunks, and the same row can retry', async t => {
  const { db: original } = source(t);
  const { importer, native, storage } = target(t);
  const manifest = createManifest(original);
  await request(importer, 'begin', { manifest });
  const entry = entries(original, manifest)[0];
  storage.failReceipt = true;
  assert.equal((await request(importer, 'row', entry)).status, 500);
  assert.equal(native.prepare('SELECT COUNT(*) AS count FROM products').get().count, 0);
  assert.equal(native.prepare('SELECT COUNT(*) AS count FROM __puro_blob_chunks').get().count, 0);
  storage.failReceipt = false;
  assert.equal((await request(importer, 'row', entry)).status, 200);
});

test('BLOB tampering and malformed values are rejected; commit catches any content mismatch', async t => {
  const { db: original } = source(t);
  const { importer, db } = target(t);
  const manifest = createManifest(original);
  await request(importer, 'begin', { manifest });
  const entry = entries(original, manifest)[0];
  const altered = structuredClone(entry);
  altered.row.image_data.sha256 = '0'.repeat(64);
  assert.equal((await request(importer, 'row', altered)).status, 400);
  altered.row.image_data = { $blob: 'YWJj', sha256: sha256(Buffer.from('abc')) };
  assert.equal((await request(importer, 'row', altered)).status, 200);
  for (const next of entries(original, manifest).slice(1)) assert.equal((await request(importer, 'row', next)).status, 200);
  assert.equal((await request(importer, 'commit', { session: manifest.sha256 })).status, 409);
  assert.equal(importer.isReady(), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM products').get().count, 2);
});

test('maximum 5 MiB photographs round trip; larger images and requests are rejected', async t => {
  const { db: original } = source(t);
  const bytes = Buffer.alloc(5 * 1024 * 1024, 173);
  original.prepare('UPDATE products SET image_data=? WHERE id=?').run(bytes, 7);
  const { importer, db } = target(t);
  const manifest = createManifest(original);
  await request(importer, 'begin', { manifest });
  const row = entries(original, manifest)[0];
  const excessive = Buffer.concat([bytes, Buffer.from([1])]);
  const invalid = { ...row, row: { ...row.row, image_data: { $blob: excessive.toString('base64'), sha256: sha256(excessive) } } };
  assert.equal((await request(importer, 'row', invalid)).status, 400);
  assert.equal((await request(importer, 'row', row)).status, 200);
  assert.deepEqual(Buffer.from(db.prepare('SELECT image_data FROM products WHERE id=?').get(7).image_data), bytes);
  const tooLarge = new Request('https://synthetic.example/__migration/row', {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Length': String(8 * 1024 * 1024 + 1) }, body: '{}'
  });
  assert.equal((await importer.handle(tooLarge, TOKEN)).status, 413);
});

test('partial import survives importer recreation, resumes the same manifest and locks after verified commit', async t => {
  const { db: original, photograph } = source(t);
  const { importer, db } = target(t);
  const manifest = createManifest(original);
  await request(importer, 'begin', { manifest });
  const rows = entries(original, manifest);
  await request(importer, 'row', rows[0]);
  assert.equal((await request(importer, 'commit', { session: manifest.sha256 })).status, 409);
  const resumed = createImporter(db);
  assert.equal(resumed.isReady(), false);
  assert.equal((await request(resumed, 'begin', { manifest })).status, 200);
  const other = structuredClone(manifest);
  other.tables[0].count++;
  other.sha256 = sha256(canonical({ format: other.format, tables: other.tables }));
  assert.equal((await request(resumed, 'begin', { manifest: other })).status, 409);
  for (const row of rows) assert.equal((await request(resumed, 'row', row)).status, 200);
  assert.equal((await request(resumed, 'commit', { session: manifest.sha256 })).status, 200);
  assert.equal(resumed.isReady(), true);
  assert.deepEqual(Buffer.from(db.prepare('SELECT image_data FROM products WHERE id=7').get().image_data), photograph);
  assert.deepEqual(Buffer.from(db.prepare('SELECT image_data FROM products WHERE id=9').get().image_data), Buffer.from([0, 1, 2, 254, 255]));
  assert.equal(db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('stock_movements').seq, 500);
  assert.equal((await request(resumed, 'begin', { manifest })).status, 409);
  assert.equal((await request(resumed, 'row', rows[0])).status, 409);
  assert.equal((await request(resumed, 'commit', { session: manifest.sha256 })).status, 200);
});

test('begin never overwrites existing business rows or a previous sequence', async t => {
  const { db: original } = source(t);
  const { importer, db } = target(t);
  const manifest = createManifest(original);
  db.prepare('INSERT INTO kits(name,components) VALUES(?,?)').run('Existente', '[]');
  assert.equal((await request(importer, 'begin', { manifest })).status, 409);
  assert.equal(db.prepare('SELECT name FROM kits').get().name, 'Existente');
  db.prepare('DELETE FROM kits').run();
  db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run('stock_movements', 50);
  assert.equal((await request(importer, 'begin', { manifest })).status, 409);
});

test('export uses a consistent read-only WAL snapshot; CLI import verifies and resumes without logging records', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-cloudflare-import-'));
  const dbPath = path.join(dir, 'synthetic.db');
  const file = path.join(dir, 'export.jsonl');
  const { db: original } = source(t, dbPath);
  cleanDirectoryAfter(t, dir);
  assert.throws(() => assertSafeOutput(dbPath, dbPath), /banco/);
  assert.throws(() => assertSafeOutput(dbPath, `${dbPath}-wal`), /banco/);
  const alias = path.join(dir, 'hardlink.jsonl');
  fs.linkSync(dbPath, alias);
  assert.throws(() => assertSafeOutput(dbPath, alias), /referencia/);
  if (process.platform === 'win32') assert.throws(() => assertSafeOutput(dbPath, dbPath.toUpperCase()), /banco/);
  original.exec('PRAGMA journal_mode=WAL');
  const expected = createManifest(original);
  const exporting = exportData({ db: dbPath, out: file });
  original.prepare('UPDATE products SET name=? WHERE id=?').run('Alterado depois do snapshot', 7);
  const result = await exporting;
  assert.equal(result.session, expected.sha256);
  assert.deepEqual(await inspectFile(file), expected);
  const firstProduct = [];
  for await (const entry of jsonLines(file)) if (entry.table === 'products') firstProduct.push(entry.row);
  assert.equal(firstProduct[0].name, 'Produto sintético');
  assert.equal(original.prepare('SELECT name FROM products WHERE id=7').get().name, 'Alterado depois do snapshot');
  const { importer, db } = target(t);
  const beforeToken = process.env.IMPORT_TOKEN;
  process.env.IMPORT_TOKEN = TOKEN;
  t.after(() => { if (beforeToken === undefined) delete process.env.IMPORT_TOKEN; else process.env.IMPORT_TOKEN = beforeToken; });
  const fetcher = (url, options) => importer.handle(new Request(url, options), TOKEN);
  const activated = await importData({ url: 'https://synthetic.example', file }, fetcher);
  assert.equal(activated.ready, true);
  assert.equal(activated.session, expected.sha256);
  assert.equal(db.prepare('SELECT name FROM products WHERE id=7').get().name, 'Produto sintético');
  assert.equal((await importData({ url: 'https://synthetic.example', file }, fetcher)).ready, true);
  assert.throws(() => destination('http://example.com'), /HTTPS/);
  assert.throws(() => destination('https://example.com/?token=secret'), /origem/);
  assert.equal(destination('http://localhost:8787'), 'http://localhost:8787');
});
