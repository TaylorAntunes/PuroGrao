const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { SqliteMap } = require('../cloudflare/persistent-map.cjs');

function database(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return db;
}

test('Cloudflare state survives rebuilding maps and isolates session and limiter namespaces', t => {
  const db = database(t);
  const sessions = new SqliteMap(db, 'sessions');
  const failures = new SqliteMap(db, 'login-failures');
  const orders = new SqliteMap(db, 'order-limits');
  assert.equal(sessions.set('shared-key', 12345), sessions);
  failures.set('shared-key', { failures: 3, expires: 23456 });
  orders.set('shared-key', { attempts: 4, created: 2, expires: 34567 });

  assert.equal(new SqliteMap(db, 'sessions').get('shared-key'), 12345);
  assert.deepEqual(new SqliteMap(db, 'login-failures').get('shared-key'), { failures: 3, expires: 23456 });
  assert.deepEqual(new SqliteMap(db, 'order-limits').get('shared-key'), { attempts: 4, created: 2, expires: 34567 });
  assert.equal(sessions.size, 1);
  assert.equal(failures.size, 1);
  assert.equal(orders.size, 1);

  assert.equal(sessions.delete('shared-key'), true);
  assert.equal(sessions.delete('shared-key'), false);
  assert.equal(sessions.size, 0);
  assert.equal(failures.size, 1);
  assert.equal(orders.size, 1);
  assert.deepEqual([...sessions], []);
  assert.deepEqual([...failures.values()], [{ failures: 3, expires: 23456 }]);
});

test('Cloudflare state clones objects and saves later mutations only after set', t => {
  const db = database(t);
  const entries = new SqliteMap(db, 'orders');
  const original = { attempts: 1, created: 0, nested: { tags: ['first'] } };
  entries.set('client', original);
  original.attempts = 50;
  original.nested.tags.push('outside');
  assert.deepEqual(entries.get('client'), { attempts: 1, created: 0, nested: { tags: ['first'] } });

  const read = entries.get('client');
  read.attempts++;
  read.nested.tags.push('pending');
  const restarted = new SqliteMap(db, 'orders');
  assert.equal(restarted.get('client').attempts, 1);
  assert.deepEqual(restarted.get('client').nested.tags, ['first']);
  entries.set('client', read);
  assert.equal(restarted.get('client').attempts, 2);
  assert.deepEqual(restarted.get('client').nested.tags, ['first', 'pending']);

  const iterated = [...entries.values()][0];
  iterated.created = 99;
  assert.equal(entries.get('client').created, 0);
});

test('Cloudflare state iteration preserves insertion order and stays inside its namespace', t => {
  const db = database(t);
  const state = new SqliteMap(db, "state' OR 1=1 --");
  new SqliteMap(db, 'other').set('hidden', 'private');
  state.set('second', 2).set('first', { value: 1 }).set('third', null);
  state.set('second', 22);
  assert.deepEqual([...state.entries()], [['second', 22], ['first', { value: 1 }], ['third', null]]);
  assert.deepEqual([...state.values()], [22, { value: 1 }, null]);
  assert.deepEqual([...state], [...state.entries()]);
  assert.equal(state.size, 3);
  assert.equal(state.delete('first'), true);
  state.set('first', 11);
  assert.deepEqual([...state], [['second', 22], ['third', null], ['first', 11]]);
  assert.equal(state.get('hidden'), undefined);
  assert.equal(state.delete('hidden'), false);
});

test('Cloudflare state treats missing keys safely and rejects values it cannot store as JSON', t => {
  const state = new SqliteMap(database(t), 'sessions');
  state.set('undefined', 'literal key').set('empty', false);
  assert.equal(state.get(undefined), undefined);
  assert.equal(state.delete(undefined), false);
  assert.equal(state.get('missing'), undefined);
  assert.equal(state.delete('missing'), false);
  assert.equal(state.get('empty'), false);
  assert.equal(state.get('undefined'), 'literal key');
  assert.throws(() => state.set(undefined, 'invalid'), TypeError);
  assert.throws(() => state.set('value', undefined), TypeError);
  const circular = {};
  circular.self = circular;
  assert.throws(() => state.set('circular', circular), TypeError);
  assert.equal(state.size, 2);
});
