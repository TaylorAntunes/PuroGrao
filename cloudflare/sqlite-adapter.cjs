const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');

const BLOB_CHUNK_BYTES = 256 * 1024;
const MAX_BINDINGS = 100;
const BLOB_PREFIX = Buffer.from('\0puro-grao:blob:v1\0');
const MAX_MARKER_BYTES = 128;
const CHUNKS_TABLE = '__puro_blob_chunks';

function binaryBytes(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function arrayBuffer(bytes) {
  // Buffer's underlying allocation can include unrelated bytes. Pass only this view.
  return Uint8Array.from(bytes).buffer;
}

function blobMarker(bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { hash, bytes: Buffer.concat([BLOB_PREFIX, Buffer.from(`${hash}:${bytes.length}`)]) };
}

function readMarker(value) {
  const bytes = binaryBytes(value);
  if (!bytes || bytes.length > MAX_MARKER_BYTES || bytes.length <= BLOB_PREFIX.length ||
      !bytes.subarray(0, BLOB_PREFIX.length).equals(BLOB_PREFIX)) return null;
  const match = /^([a-f0-9]{64}):([1-9]\d*)$/.exec(bytes.subarray(BLOB_PREFIX.length).toString('ascii'));
  if (!match) return null;
  const length = Number(match[2]);
  return Number.isSafeInteger(length) && length > BLOB_CHUNK_BYTES ? { hash: match[1], length } : null;
}

// Keep source text intact except parameter tokens. SQL strings, identifiers and
// comments can all contain characters that resemble parameters or separators.
function compileSql(source) {
  if (typeof source !== 'string') throw new TypeError('SQL must be a string.');
  let output = '';
  let current = '';
  let words = [];
  let positionalCount = 0;
  const parameters = [];
  const statements = [];
  const append = text => { output += text; current += text; };
  const finish = () => {
    if (words.length) statements.push({ sql: current, words });
    current = '';
    words = [];
  };
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '-' && next === '-') {
      let end = index + 2;
      while (end < source.length && !['\r', '\n'].includes(source[end])) end++;
      append(source.slice(index, end));
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close < 0 ? source.length : close + 2;
      append(source.slice(index, end));
      index = end;
      continue;
    }
    if (["'", '"', '`', '['].includes(char)) {
      const closing = char === '[' ? ']' : char;
      let end = index + 1;
      let identifier = '';
      while (end < source.length) {
        if (source[end] === closing) {
          if (char !== '[' && source[end + 1] === closing) {
            identifier += closing;
            end += 2;
            continue;
          }
          end++;
          break;
        }
        identifier += source[end++];
      }
      if (char !== "'") words.push(identifier.toUpperCase());
      append(source.slice(index, end));
      index = end;
      continue;
    }
    if (char === ';') {
      append(char);
      finish();
      index++;
      continue;
    }
    if (['@', ':', '$'].includes(char) && /[a-z_]/i.test(next || '')) {
      let end = index + 2;
      while (end < source.length && /[a-z\d_]/i.test(source[end])) end++;
      const token = source.slice(index, end);
      parameters.push({ token, name: token.slice(1) });
      append('?');
      index = end;
      continue;
    }
    if (char === '?') {
      if (/\d/.test(next || '')) throw new Error('Numbered SQL bindings are unsupported; use ? or @name.');
      parameters.push({ index: positionalCount++ });
      append(char);
      index++;
      continue;
    }
    if (/[a-z_]/i.test(char)) {
      let end = index + 1;
      while (end < source.length && /[a-z\d_]/i.test(source[end])) end++;
      const word = source.slice(index, end);
      words.push(word.toUpperCase());
      append(word);
      index = end;
      continue;
    }
    append(char);
    index++;
  }
  finish();
  if (parameters.length > MAX_BINDINGS) {
    throw new RangeError(`Cloudflare SQLite supports at most ${MAX_BINDINGS} bindings per query; use json_each(?) for larger lists.`);
  }
  return { sql: output, statements, parameters, positionalCount };
}

function ignoredPragma(statement) {
  return statement.words[0] === 'PRAGMA' &&
    ['JOURNAL_MODE', 'BUSY_TIMEOUT'].includes(statement.words[1]);
}

function checkTransactions(statements) {
  for (const { words } of statements) {
    if (['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(words[0])) {
      throw new Error('Cloudflare SQLite transactions must use db.transaction(callback), backed by storage.transactionSync().');
    }
  }
}

function changesProductImages({ words }) {
  let tableIndex = -1;
  if (['INSERT', 'REPLACE'].includes(words[0])) tableIndex = words.indexOf('INTO') + 1;
  else if (words[0] === 'DELETE' && words[1] === 'FROM') tableIndex = 2;
  else if (words[0] === 'UPDATE') tableIndex = words[1] === 'OR' ? 3 : 1;
  if (tableIndex < 1) return false;
  // Accept both products and main.products, including quoted identifiers.
  if (words[tableIndex] === 'MAIN') tableIndex++;
  if (words[tableIndex] !== 'PRODUCTS') return false;
  return ['DELETE', 'REPLACE'].includes(words[0]) || words.includes('IMAGE_DATA');
}

function bindValues(compiled, args) {
  const first = args[0];
  const named = first && typeof first === 'object' && !binaryBytes(first) && !Array.isArray(first) ? first : null;
  const positional = named ? args.slice(1) : args;
  if (positional.length !== compiled.positionalCount) {
    throw new Error(`Expected ${compiled.positionalCount} positional SQL bindings, received ${positional.length}.`);
  }
  return compiled.parameters.map(parameter => {
    if ('index' in parameter) return positional[parameter.index];
    if (named && Object.hasOwn(named, parameter.token)) return named[parameter.token];
    if (named && Object.hasOwn(named, parameter.name)) return named[parameter.name];
    throw new Error(`Missing named SQL binding ${parameter.token}.`);
  });
}

class StorageDatabase {
  constructor(storage) {
    if (!storage?.sql || typeof storage.transactionSync !== 'function') {
      throw new TypeError('StorageDatabase requires Durable Object storage with sql and transactionSync.');
    }
    this.storage = storage;
    this.sql = storage.sql;
    this.transactionDepth = 0;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
      hash TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (hash, chunk_index)
    )`).toArray();
  }

  transaction(callback) {
    if (typeof callback !== 'function') throw new TypeError('A transaction requires a synchronous callback.');
    const invoke = () => {
      this.transactionDepth++;
      try {
        const result = callback();
        if (result && typeof result.then === 'function') {
          throw new TypeError('Cloudflare SQLite transaction callbacks must complete synchronously.');
        }
        return result;
      } finally {
        this.transactionDepth--;
      }
    };
    return this.transactionDepth ? invoke() : this.storage.transactionSync(invoke);
  }

  exec(source) {
    const compiled = compileSql(source);
    checkTransactions(compiled.statements);
    if (compiled.parameters.length) throw new Error('exec() does not accept bindings; use prepare().');
    const statements = compiled.statements.filter(statement => !ignoredPragma(statement));
    if (!statements.length) return;
    this.transaction(() => {
      this.sql.exec(statements.map(statement => statement.sql).join('\n')).toArray();
      if (statements.some(changesProductImages)) this.collectUnusedBlobs();
    });
  }

  prepare(source) {
    const compiled = compileSql(source);
    checkTransactions(compiled.statements);
    if (compiled.statements.length !== 1) throw new Error('prepare() requires exactly one SQL statement; use exec() for scripts.');
    const ignored = ignoredPragma(compiled.statements[0]);
    const query = (args, mode) => {
      const bindings = bindValues(compiled, args);
      if (ignored) return mode === 'all' ? [] : mode === 'run' ? { changes: 0, lastInsertRowid: 0 } : undefined;
      const imageWrite = changesProductImages(compiled.statements[0]);
      const hasLargeBlob = bindings.some(value => (binaryBytes(value)?.length || 0) > BLOB_CHUNK_BYTES);
      const execute = () => {
        const values = bindings.map(value => this.storageValue(value));
        const rows = this.sql.exec(compiled.sql, ...values).toArray();
        // Capture SQLite's statement metadata before chunk cleanup writes anything.
        const metadata = mode === 'run' ? { ...this.sql.exec(
          'SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid'
        ).toArray()[0] } : null;
        const hydrated = mode === 'run' ? null : mode === 'get'
          ? (rows.length ? this.hydrateRow(rows[0]) : undefined)
          : rows.map(row => this.hydrateRow(row));
        if (imageWrite || hasLargeBlob) this.collectUnusedBlobs();
        return mode === 'run' ? metadata : hydrated;
      };
      return mode === 'run' || imageWrite || hasLargeBlob ? this.transaction(execute) : execute();
    };
    return {
      all: (...args) => query(args, 'all'),
      get: (...args) => query(args, 'get'),
      run: (...args) => query(args, 'run'),
    };
  }

  storageValue(value) {
    const bytes = binaryBytes(value);
    if (bytes) {
      if (bytes.length <= BLOB_CHUNK_BYTES) return arrayBuffer(bytes);
      const marker = blobMarker(bytes);
      for (let offset = 0, index = 0; offset < bytes.length; offset += BLOB_CHUNK_BYTES, index++) {
        this.sql.exec(`INSERT OR IGNORE INTO ${CHUNKS_TABLE}(hash, chunk_index, data) VALUES (?, ?, ?)`,
          marker.hash, index, arrayBuffer(bytes.subarray(offset, offset + BLOB_CHUNK_BYTES))).toArray();
      }
      return arrayBuffer(marker.bytes);
    }
    if (value === null || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    throw new TypeError('SQL bindings must be null, a string, a finite number, or binary data.');
  }

  hydrateRow(row) {
    const hydrated = { ...row };
    for (const [key, value] of Object.entries(hydrated)) {
      const marker = readMarker(value);
      if (!marker) continue;
      const chunks = this.sql.exec(`SELECT chunk_index, data FROM ${CHUNKS_TABLE} WHERE hash=? ORDER BY chunk_index`, marker.hash).toArray();
      if (chunks.length !== Math.ceil(marker.length / BLOB_CHUNK_BYTES) ||
          chunks.some((chunk, index) => chunk.chunk_index !== index || !binaryBytes(chunk.data))) {
        throw new Error('Stored product image is incomplete.');
      }
      const bytes = Buffer.concat(chunks.map(chunk => binaryBytes(chunk.data)));
      if (bytes.length !== marker.length || createHash('sha256').update(bytes).digest('hex') !== marker.hash) {
        throw new Error('Stored product image failed its integrity check.');
      }
      hydrated[key] = bytes;
    }
    return hydrated;
  }

  collectUnusedBlobs() {
    const references = new Set();
    if (this.sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'").toArray().length) {
      const rows = this.sql.exec('SELECT image_data FROM products WHERE image_data IS NOT NULL AND length(image_data)<=?', MAX_MARKER_BYTES).toArray();
      for (const row of rows) {
        const marker = readMarker(row.image_data);
        if (marker) references.add(marker.hash);
      }
    }
    for (const { hash } of this.sql.exec(`SELECT DISTINCT hash FROM ${CHUNKS_TABLE}`).toArray()) {
      if (!references.has(hash)) this.sql.exec(`DELETE FROM ${CHUNKS_TABLE} WHERE hash=?`, hash).toArray();
    }
  }

  close() {}
}

module.exports = { StorageDatabase, BLOB_CHUNK_BYTES };
