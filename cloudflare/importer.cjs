const { createHash, timingSafeEqual } = require('node:crypto');
const { Buffer } = require('node:buffer');

const FORMAT = 'puro-grao-cloudflare-v1';
const TABLES = Object.freeze(['products', 'orders', 'order_items', 'kits', 'site_banner',
  'stock_movements', 'in_person_sale_requests', 'public_order_requests', 'sqlite_sequence']);
const KEYS = Object.freeze(Object.fromEntries(TABLES.map(name => [name,
  name === 'sqlite_sequence' ? 'name' : name.endsWith('_requests') ? 'request_id' : 'id'])));
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 5 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return object(value) && canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function schemaFor(db, table) {
  if (!TABLES.includes(table)) fail(400, 'Tabela inválida.');
  return db.prepare(`PRAGMA table_info(${table})`).all().map(column => ({
    name: column.name, type: column.type.toUpperCase(), notnull: Number(column.notnull), pk: Number(column.pk)
  }));
}
function comparableSchema(columns) {
  return Array.isArray(columns) ? [...columns].sort((left, right) =>
    String(left?.name).localeCompare(String(right?.name), 'en')) : columns;
}
function encodeRow(row, columns) {
  const result = {};
  for (const column of columns) {
    const value = row[column.name];
    const bytes = value instanceof ArrayBuffer ? Buffer.from(value)
      : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : null;
    result[column.name] = bytes ? { $blob: bytes.toString('base64'), sha256: sha256(bytes) } : value;
  }
  return result;
}
function rowKeys(db, table) {
  return db.prepare(`SELECT ${KEYS[table]} FROM ${table} ORDER BY ${KEYS[table]}`).all();
}
function tableSummary(db, table, columns) {
  const keys = rowKeys(db, table);
  const digest = createHash('sha256');
  const read = db.prepare(`SELECT * FROM ${table} WHERE ${KEYS[table]} = ?`);
  for (const key of keys) {
    const row = encodeRow(read.get(key[KEYS[table]]), columns);
    digest.update(canonical(row)).update('\n');
  }
  return { count: keys.length, sha256: digest.digest('hex') };
}
function createManifest(db) {
  const tables = TABLES.map(name => {
    const columns = schemaFor(db, name);
    if (!columns.length) fail(400, `Tabela ausente: ${name}. Atualize o banco local antes de exportar.`);
    return { name, columns, ...tableSummary(db, name, columns) };
  });
  return { type: 'manifest', format: FORMAT, tables, sha256: sha256(canonical({ format: FORMAT, tables })) };
}
function validateManifest(db, manifest) {
  if (!exactKeys(manifest, ['type', 'format', 'tables', 'sha256']) || manifest.type !== 'manifest'
      || manifest.format !== FORMAT || !SHA256.test(manifest.sha256) || !Array.isArray(manifest.tables)
      || manifest.tables.length !== TABLES.length) fail(400, 'Manifesto inválido.');
  for (let index = 0; index < TABLES.length; index++) {
    const table = manifest.tables[index];
    if (!exactKeys(table, ['name', 'columns', 'count', 'sha256']) || table.name !== TABLES[index]
        || !Number.isSafeInteger(table.count) || table.count < 0 || table.count > 10000000
        || !SHA256.test(table.sha256)
        || canonical(comparableSchema(table.columns)) !== canonical(comparableSchema(schemaFor(db, table.name)))) {
      fail(400, 'O manifesto não corresponde ao esquema e às tabelas permitidas.');
    }
  }
  if (manifest.tables.at(-1).count > 1) fail(400, 'Sequência SQLite inválida.');
  const expected = sha256(canonical({ format: manifest.format, tables: manifest.tables }));
  if (manifest.sha256 !== expected) fail(400, 'Hash do manifesto inválido.');
  return manifest;
}
function decodeRow(table, row, columns) {
  if (!exactKeys(row, columns.map(column => column.name))) fail(400, 'Colunas da linha inválidas.');
  const values = [];
  for (const column of columns) {
    const value = row[column.name];
    if (value === null) {
      if (column.notnull || column.pk || column.name === KEYS[table]) fail(400, 'Valor obrigatório ausente.');
      values.push(null);
    } else if (column.type === 'BLOB') {
      if (!exactKeys(value, ['$blob', 'sha256']) || typeof value.$blob !== 'string'
          || !SHA256.test(value.sha256) || value.$blob.length > Math.ceil(MAX_BLOB_BYTES / 3) * 4
          || value.$blob.length % 4 !== 0) {
        fail(400, 'Imagem codificada inválida.');
      }
      const bytes = Buffer.from(value.$blob, 'base64');
      if (bytes.length > MAX_BLOB_BYTES || bytes.toString('base64') !== value.$blob || sha256(bytes) !== value.sha256) {
        fail(400, 'O hash ou tamanho da imagem é inválido.');
      }
      values.push(bytes);
    } else if (column.type === 'INTEGER' || (table === 'sqlite_sequence' && column.name === 'seq')) {
      if (!Number.isSafeInteger(value)) fail(400, 'Inteiro inválido.');
      values.push(value);
    } else if (column.type === 'TEXT' || (table === 'sqlite_sequence' && column.name === 'name')) {
      if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BODY_BYTES) fail(400, 'Texto inválido.');
      values.push(value);
    } else fail(400, 'Tipo de coluna não permitido.');
  }
  const key = row[KEYS[table]];
  if (typeof key === 'string' && (!key.length || key.length > 2048)) fail(400, 'Identificador inválido.');
  if (table === 'sqlite_sequence' && (row.name !== 'stock_movements' || row.seq < 0)) fail(400, 'Sequência SQLite inválida.');
  return values;
}
async function readBody(request) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail(413, 'Corpo excede 8 MiB.');
  if (!request.body) fail(400, 'Corpo JSON obrigatório.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); fail(413, 'Corpo excede 8 MiB.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { fail(400, 'JSON inválido.'); }
}
function response(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function createImporter(db) {
  db.exec('CREATE TABLE IF NOT EXISTS __puro_migration (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const getMeta = key => db.prepare('SELECT value FROM __puro_migration WHERE key = ?').get(key);
  const state = () => { const row = getMeta('state'); return row ? JSON.parse(row.value) : null; };
  const putMeta = (key, value) => {
    const json = JSON.stringify(value);
    if (getMeta(key)) db.prepare('UPDATE __puro_migration SET value = ? WHERE key = ?').run(json, key);
    else db.prepare('INSERT INTO __puro_migration (key, value) VALUES (?, ?)').run(key, json);
  };
  function status() {
    const current = state();
    return { ready: Boolean(current?.ready), session: current?.session || null,
      counts: Object.fromEntries(TABLES.map(table => [table, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)])),
      expected: current ? Object.fromEntries(current.manifest.tables.map(table => [table.name, table.count])) : null };
  }
  function requireSession(session) {
    const current = state();
    if (!current || !SHA256.test(session) || current.session !== session) fail(409, 'Sessão de importação diferente.');
    return current;
  }
  function begin(body) {
    if (!exactKeys(body, ['manifest'])) fail(400, 'Início de importação inválido.');
    const manifest = validateManifest(db, body.manifest);
    return db.transaction(() => {
      const current = state();
      if (current?.ready) fail(409, 'A importação já foi finalizada.');
      if (current) {
        if (current.session !== manifest.sha256 || canonical(current.manifest) !== canonical(manifest)) fail(409, 'Outra importação está em andamento.');
        return status();
      }
      for (const table of TABLES.slice(0, -1)) {
        if (db.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get()) fail(409, 'O destino precisa estar vazio.');
      }
      const sequences = db.prepare('SELECT name, seq FROM sqlite_sequence').all();
      if (sequences.some(row => row.name !== 'stock_movements' || Number(row.seq) !== 0)) fail(409, 'O destino contém uma sequência existente.');
      db.prepare('DELETE FROM sqlite_sequence WHERE name = ? AND seq = 0').run('stock_movements');
      putMeta('state', { session: manifest.sha256, manifest, ready: false });
      return status();
    });
  }
  function insert(body) {
    if (!exactKeys(body, ['session', 'table', 'row']) || !TABLES.includes(body.table)) fail(400, 'Linha de importação inválida.');
    const columns = schemaFor(db, body.table);
    const values = decodeRow(body.table, body.row, columns);
    const digest = sha256(canonical(body.row));
    const receipt = `row:${body.table}:${sha256(canonical(body.row[KEYS[body.table]]))}`;
    return db.transaction(() => {
      const current = requireSession(body.session);
      if (current.ready) fail(409, 'A importação já foi finalizada.');
      const received = getMeta(receipt);
      if (received) {
        if (JSON.parse(received.value).sha256 !== digest) fail(409, 'A linha já recebida possui conteúdo diferente.');
        return { accepted: true, duplicate: true };
      }
      const expected = current.manifest.tables.find(table => table.name === body.table);
      const receipts = Number(db.prepare('SELECT COUNT(*) AS count FROM __puro_migration WHERE key LIKE ?').get(`row:${body.table}:%`).count);
      if (receipts >= expected.count) fail(409, 'A tabela já recebeu todas as linhas declaradas.');
      if (body.table === 'sqlite_sequence') {
        const movements = current.manifest.tables.find(table => table.name === 'stock_movements');
        const imported = Number(db.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count);
        if (imported !== movements.count) fail(409, 'Importe as movimentações antes da sequência.');
        const maximum = db.prepare('SELECT MAX(id) AS maximum FROM stock_movements').get().maximum || 0;
        if (body.row.seq < maximum) fail(400, 'A sequência é inferior aos identificadores importados.');
        if (db.prepare('SELECT 1 AS present FROM sqlite_sequence WHERE name = ?').get(body.row.name)) {
          db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(body.row.seq, body.row.name);
        } else db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(body.row.name, body.row.seq);
      } else {
        if (db.prepare(`SELECT 1 AS present FROM ${body.table} WHERE ${KEYS[body.table]} = ?`).get(body.row[KEYS[body.table]])) {
          fail(409, 'A linha já existe sem comprovante desta importação.');
        }
        db.prepare(`INSERT INTO ${body.table} (${columns.map(column => column.name).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
      }
      putMeta(receipt, { sha256: digest });
      return { accepted: true, duplicate: false };
    });
  }
  function commit(body) {
    if (!exactKeys(body, ['session'])) fail(400, 'Finalização inválida.');
    return db.transaction(() => {
      const current = requireSession(body.session);
      if (current.ready) return status();
      for (const table of current.manifest.tables) {
        const actual = tableSummary(db, table.name, table.columns);
        const receipts = Number(db.prepare('SELECT COUNT(*) AS count FROM __puro_migration WHERE key LIKE ?').get(`row:${table.name}:%`).count);
        if (actual.count !== table.count || actual.sha256 !== table.sha256 || receipts !== table.count) {
          fail(409, `Contagem ou hash divergente na tabela ${table.name}.`);
        }
      }
      putMeta('state', { ...current, ready: true });
      return status();
    });
  }
  return {
    isReady: () => Boolean(state()?.ready),
    async handle(request, token) {
      const route = new URL(request.url).pathname;
      if (!['/__migration/status', '/__migration/begin', '/__migration/row', '/__migration/commit'].includes(route)
          || typeof token !== 'string' || !token.trim()) return response(404, { error: 'Não encontrado.' });
      const supplied = request.headers.get('authorization') || '';
      if (!timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(`Bearer ${token}`).digest())) {
        return response(401, { error: 'Não autorizado.' });
      }
      try {
        if (route === '/__migration/status') {
          if (request.method !== 'GET') return response(405, { error: 'Método inválido.' });
          return response(200, status());
        }
        if (request.method !== 'POST') return response(405, { error: 'Método inválido.' });
        const body = await readBody(request);
        return response(200, route === '/__migration/begin' ? begin(body) : route === '/__migration/row' ? insert(body) : commit(body));
      } catch (error) {
        return response(error.status || 500, { error: error.status ? error.message : 'Falha ao importar. Nenhuma alteração desta requisição foi aplicada.' });
      }
    }
  };
}

module.exports = { createImporter, createManifest, validateManifest, tableSummary, schemaFor, encodeRow,
  rowKeys, canonical, sha256, FORMAT, TABLES, KEYS, MAX_BODY_BYTES, MAX_BLOB_BYTES };
