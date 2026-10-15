const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { StorageDatabase, BLOB_CHUNK_BYTES } = require('../cloudflare/sqlite-adapter.cjs');

function fixture(t) {
  const native = new DatabaseSync(':memory:');
  const calls = [];
  let transactions = 0;
  const storage = {
    sql: {
      exec(sql, ...bindings) {
        calls.push({ sql, bindings });
        assert.ok(bindings.length <= 100, 'Cloudflare binding limit');
        for (const binding of bindings) {
          if (binding instanceof ArrayBuffer) assert.ok(binding.byteLength <= BLOB_CHUNK_BYTES);
          assert.equal(ArrayBuffer.isView(binding), false, 'binary bindings use exact ArrayBuffers');
        }
        // Adapter scripts contain DDL only; values in queries always use bindings.
        const script = !bindings.length && /;\s*\S/.test(sql.trim().replace(/;$/, ''));
        let rows;
        if (script) { native.exec(sql); rows = []; }
        else rows = native.prepare(sql).all(...bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
        return { toArray: () => rows, next: () => rows.length ? { value: rows.shift(), done: false } : { done: true } };
      },
    },
    transactionSync(callback) {
      transactions++;
      native.exec('BEGIN IMMEDIATE');
      try {
        const result = callback();
        native.exec('COMMIT');
        return result;
      } catch (error) {
        native.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const db = new StorageDatabase(storage);
  db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, image_data BLOB);
    CREATE TABLE kits (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE INDEX kit_name ON kits(name);`);
  t.after(() => native.close());
  return { db, native, calls, transactionCount: () => transactions };
}

function image(size = BLOB_CHUNK_BYTES * 2 + 43) {
  return Buffer.from(Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) % 251));
}

const chunks = native => native.prepare('SELECT COUNT(*) AS count FROM __puro_blob_chunks').get().count;

test('named bindings preserve SQL literals/comments and repeat values while ignoring extra object keys', t => {
  const { db } = fixture(t);
  const result = db.prepare(`SELECT @value AS first, @value AS repeated,
    'literal @value; ''@ignored''' AS literal,
    "@identifier"."label" AS label /* @block ? ; */
    FROM (SELECT 'ok' AS label) AS "@identifier" -- @line ? ;
    WHERE @value = ?`).get({ value: 42, unused: 'ignored' }, 42);
  assert.deepEqual(result, { first: 42, repeated: 42, literal: "literal @value; '@ignored'", label: 'ok' });
  assert.deepEqual(db.prepare('SELECT @value AS value').get({ '@value': 'prefixed', extra: true }), { value: 'prefixed' });
  assert.equal(db.prepare('SELECT id FROM products WHERE id=?').get(999), undefined);
  assert.throws(() => db.prepare('SELECT @value').get({ other: 1 }), /Missing named SQL binding @value/);
});

test('run reports principal statement changes and lastInsertRowid, including with indexes and cleanup', t => {
  const { db } = fixture(t);
  assert.deepEqual(db.prepare('INSERT INTO kits(name) VALUES(?)').run('Primeiro'), { changes: 1, lastInsertRowid: 1 });
  assert.deepEqual(db.prepare('INSERT INTO kits(name) VALUES(?)').run('Segundo'), { changes: 1, lastInsertRowid: 2 });
  assert.deepEqual(db.prepare('UPDATE kits SET name=? WHERE id=?').run('Outro', 999), { changes: 0, lastInsertRowid: 2 });
  assert.deepEqual(db.prepare('DELETE FROM kits WHERE id=?').run(1), { changes: 1, lastInsertRowid: 2 });
  assert.deepEqual(db.prepare('INSERT INTO products(id,name,image_data) VALUES(?,?,?)').run(90, 'Imagem', image()), { changes: 1, lastInsertRowid: 90 });
  assert.equal(db.prepare('UPDATE products SET image_data=NULL WHERE id=?').run(90).changes, 1);
});

test('large image bytes round trip through bounded chunks and short nonnull BLOB markers', t => {
  const { db, native, transactionCount } = fixture(t);
  const original = image();
  const before = transactionCount();
  db.prepare('INSERT INTO products(id,name,image_data) VALUES(@id,@name,@image)').run({ id: 1, name: 'Foto', image: original });
  assert.equal(transactionCount(), before + 1);
  const physical = native.prepare('SELECT image_data FROM products WHERE id=1').get().image_data;
  assert.ok(physical.length > 0 && physical.length < 128);
  assert.equal(chunks(native), 3);
  assert.ok(native.prepare('SELECT MAX(LENGTH(data)) AS size FROM __puro_blob_chunks').get().size <= BLOB_CHUNK_BYTES);
  assert.deepEqual(db.prepare('SELECT image_data FROM products WHERE id=?').get(1).image_data, original);
  assert.deepEqual(db.prepare('SELECT image_data AS photograph FROM products').all()[0].photograph, original);
});

test('small views bind only their bytes and do not create chunks', t => {
  const { db, native } = fixture(t);
  const allocation = Buffer.from([99, 1, 2, 3, 88]);
  db.prepare('INSERT INTO products(id,name,image_data) VALUES(?,?,?)').run(1, 'Pequena', allocation.subarray(1, 4));
  assert.deepEqual(Buffer.from(db.prepare('SELECT image_data FROM products').get().image_data), Buffer.from([1, 2, 3]));
  db.prepare('UPDATE products SET image_data=? WHERE id=1').run(Uint8Array.from([5, 6]).buffer);
  assert.deepEqual(Buffer.from(db.prepare('SELECT image_data FROM products').get().image_data), Buffer.from([5, 6]));
  assert.equal(chunks(native), 0);
});

test('a failed principal statement rolls back inserted chunks and leaves the previous image intact', t => {
  const { db, native } = fixture(t);
  const previous = image();
  const replacement = image(BLOB_CHUNK_BYTES + 91);
  db.prepare('INSERT INTO products(id,name,image_data) VALUES(?,?,?)').run(1, 'Antes', previous);
  const before = chunks(native);
  assert.throws(() => db.prepare('UPDATE products SET image_data=?,name=NULL WHERE id=?').run(replacement, 1), /NOT NULL/);
  assert.equal(chunks(native), before);
  assert.deepEqual(db.prepare('SELECT image_data FROM products WHERE id=1').get().image_data, previous);
});

test('an outer transaction rolls back principal writes and chunks without nesting storage transactions', t => {
  const { db, native, transactionCount } = fixture(t);
  const before = transactionCount();
  assert.throws(() => db.transaction(() => {
    db.prepare('INSERT INTO products(id,name,image_data) VALUES(?,?,?)').run(1, 'Rollback', image());
    db.transaction(() => db.prepare('INSERT INTO kits(name) VALUES(?)').run('Rollback'));
    throw new Error('reject sale');
  }), /reject sale/);
  assert.equal(transactionCount(), before + 1);
  assert.equal(chunks(native), 0);
  assert.equal(native.prepare('SELECT COUNT(*) AS count FROM products').get().count, 0);
  assert.equal(native.prepare('SELECT COUNT(*) AS count FROM kits').get().count, 0);
});

test('chunk cleanup preserves images shared by products and removes chunks after the final reference', t => {
  const { db, native } = fixture(t);
  const shared = image();
  const other = image(BLOB_CHUNK_BYTES + 13);
  const insert = db.prepare('INSERT INTO products(id,name,image_data) VALUES(?,?,?)');
  insert.run(1, 'Primeiro', shared);
  insert.run(2, 'Compartilhada', shared);
  assert.equal(chunks(native), 3);
  db.prepare('UPDATE products SET image_data=? WHERE id=1').run(other);
  assert.equal(chunks(native), 5);
  assert.deepEqual(db.prepare('SELECT image_data FROM products WHERE id=2').get().image_data, shared);
  assert.equal(db.prepare('DELETE FROM products WHERE id=?').run(1).changes, 1);
  assert.equal(chunks(native), 3);
  db.exec('DELETE FROM products WHERE id=2');
  assert.equal(chunks(native), 0);
});

test('rollback restores old image chunks removed earlier in the same transaction', t => {
  const { db, native } = fixture(t);
  const previous = image();
  db.prepare('INSERT INTO products(id,name,image_data) VALUES(?,?,?)').run(1, 'Preservada', previous);
  assert.throws(() => db.transaction(() => {
    db.prepare('UPDATE products SET image_data=? WHERE id=1').run(image(BLOB_CHUNK_BYTES + 19));
    assert.equal(chunks(native), 2, 'old chunks were collected before the later failure');
    db.prepare('INSERT INTO kits(name) VALUES(NULL)').run();
  }), /NOT NULL/);
  assert.equal(chunks(native), 3);
  assert.deepEqual(db.prepare('SELECT image_data FROM products WHERE id=1').get().image_data, previous);
});

test('metadata projections never fetch or hydrate image chunks', t => {
  const { db, calls } = fixture(t);
  db.prepare('INSERT INTO products(id,name,image_data) VALUES(?,?,?)').run(1, 'Catálogo', image());
  calls.length = 0;
  assert.deepEqual(db.prepare('SELECT id,name FROM products').all(), [{ id: 1, name: 'Catálogo' }]);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].sql, /__puro_blob_chunks/);
});

test('transaction control fails clearly, supported introspection survives and binding limits are explicit', t => {
  const { db } = fixture(t);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  assert.ok(db.prepare('PRAGMA table_info(products)').all().some(column => column.name === 'image_data'));
  assert.throws(() => db.exec('/* comment */ BEGIN IMMEDIATE;'), /storage\.transactionSync/);
  assert.throws(() => db.prepare('SAVEPOINT sale'), /db\.transaction/);
  assert.throws(() => db.prepare(`SELECT ${Array(101).fill('?').join(',')}`), /at most 100 bindings/);
  assert.throws(() => db.prepare(`SELECT ${Array(101).fill('@same').join(',')}`), /json_each/);
  assert.equal(typeof db.function, 'undefined');
  db.close();
  assert.equal(db.prepare('SELECT 1 AS alive').get().alive, 1);
});
