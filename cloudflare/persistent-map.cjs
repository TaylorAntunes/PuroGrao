// Synchronous, JSON-backed state for sessions and request limits. Reads return
// independent values; callers must set() again after changing an object.
class SqliteMap {
  #db;
  #namespace;

  constructor(db, namespace) {
    if (typeof namespace !== 'string') throw new TypeError('SqliteMap namespace must be a string.');
    this.#db = db;
    this.#namespace = namespace;
    db.exec(`CREATE TABLE IF NOT EXISTS __puro_state (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY(namespace, key)
    )`);
  }

  get(key) {
    if (typeof key !== 'string') return undefined;
    const row = this.#db.prepare('SELECT value FROM __puro_state WHERE namespace=? AND key=?')
      .get(this.#namespace, key);
    return row ? JSON.parse(row.value) : undefined;
  }

  set(key, value) {
    if (typeof key !== 'string') throw new TypeError('SqliteMap keys must be strings.');
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('SqliteMap values must be JSON serializable.');
    this.#db.prepare(`INSERT INTO __puro_state(namespace, key, value) VALUES(?, ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value`)
      .run(this.#namespace, key, json);
    return this;
  }

  delete(key) {
    if (typeof key !== 'string') return false;
    return this.#db.prepare('DELETE FROM __puro_state WHERE namespace=? AND key=?')
      .run(this.#namespace, key).changes > 0;
  }

  get size() {
    return this.#db.prepare('SELECT COUNT(*) AS count FROM __puro_state WHERE namespace=?')
      .get(this.#namespace).count;
  }

  *entries() {
    const rows = this.#db.prepare('SELECT key, value FROM __puro_state WHERE namespace=? ORDER BY rowid')
      .all(this.#namespace);
    for (const row of rows) yield [row.key, JSON.parse(row.value)];
  }

  *values() {
    for (const [, value] of this.entries()) yield value;
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

module.exports = { SqliteMap };
