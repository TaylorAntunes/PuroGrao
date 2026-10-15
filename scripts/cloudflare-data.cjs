#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { emitKeypressEvents } = require('node:readline');
const {
  createManifest, canonical, sha256, encodeRow, rowKeys, TABLES, KEYS, FORMAT, MAX_BODY_BYTES
} = require('../cloudflare/importer.cjs');

const DEFAULT_FILE = path.resolve(__dirname, '..', 'artifacts', 'cloudflare-data.jsonl');
async function readImportToken(input = process.stdin, output = process.stderr) {
  if (process.env.IMPORT_TOKEN?.trim()) return process.env.IMPORT_TOKEN;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Defina IMPORT_TOKEN no ambiente ou execute em um terminal para informá-lo sem exibição.');
  }
  const wasRaw = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing === true;
  emitKeypressEvents(input);
  output.write('IMPORT_TOKEN (entrada oculta): ');
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let token = '';
    const cleanup = () => {
      input.removeListener('keypress', keypress);
      input.removeListener('end', ended);
      input.removeListener('error', failed);
      input.setRawMode(wasRaw);
      if (!wasFlowing) input.pause();
      output.write('\n');
    };
    const failed = () => { cleanup(); reject(new Error('Não foi possível ler o token.')); };
    const ended = () => { cleanup(); reject(new Error('Entrada do token interrompida.')); };
    const keypress = (text, key = {}) => {
      if (key.ctrl && ['c', 'd'].includes(key.name)) { cleanup(); reject(new Error('Entrada do token cancelada.')); }
      else if (['return', 'enter'].includes(key.name)) {
        cleanup();
        if (token.trim()) resolve(token); else reject(new Error('O token não pode estar vazio.'));
      } else if (['backspace', 'delete'].includes(key.name)) token = token.slice(0, -1);
      else if (!key.ctrl && !key.meta && typeof text === 'string' && !/[\x00-\x1f\x7f]/.test(text)) {
        token += text;
        if (token.length > 4096) { cleanup(); reject(new Error('O token excede o tamanho permitido.')); }
      }
    };
    input.on('keypress', keypress);
    input.once('end', ended);
    input.once('error', failed);
  });
}
function physicalPath(filename) {
  let existing = filename;
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}
function assertSafeOutput(dbPath, filename) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const physicalDb = physicalPath(dbPath);
  const physicalOutput = physicalPath(filename);
  const protectedPaths = new Set([dbPath, physicalDb].flatMap(base =>
    ['', '-wal', '-shm', '-journal'].map(suffix => normalize(base + suffix))));
  if (protectedPaths.has(normalize(filename)) || protectedPaths.has(normalize(physicalOutput))) {
    throw new Error('A exportação não pode substituir o banco de origem ou seus arquivos auxiliares.');
  }
  if (fs.existsSync(filename)) {
    const outputStat = fs.statSync(filename);
    for (const protectedPath of ['', '-wal', '-shm', '-journal'].map(suffix => physicalDb + suffix)) {
      if (!fs.existsSync(protectedPath)) continue;
      const sourceStat = fs.statSync(protectedPath);
      if (sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino) {
        throw new Error('O arquivo de saída referencia o banco de origem ou um arquivo auxiliar.');
      }
    }
  }
}
function argsFrom(argv) {
  const [command, ...rest] = argv;
  if (!['export', 'import', 'status'].includes(command)) throw new Error('Use export, import ou status.');
  const options = { command };
  const allowed = command === 'export' ? ['db', 'out'] : command === 'import' ? ['url', 'file'] : ['url'];
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.replace(/^--/, '');
    if (!rest[index]?.startsWith('--') || !allowed.includes(key) || !rest[index + 1]
        || rest[index + 1].startsWith('--') || options[key] !== undefined) throw new Error('Argumento inválido.');
    options[key] = rest[index + 1];
  }
  return options;
}
function destination(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Informe --url com a origem HTTPS da loja.'); }
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Use apenas a origem da loja, sem credenciais, caminho, query ou fragmento.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('HTTPS é obrigatório; HTTP só é permitido em localhost.');
  return url.origin;
}
function migrationClient(origin, token, fetcher = fetch) {
  if (!token || !token.trim()) throw new Error('Defina IMPORT_TOKEN no ambiente, sem incluí-lo em comandos ou arquivos de exportação.');
  return async (route, body) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > MAX_BODY_BYTES) throw new Error('Uma linha excede o limite de 8 MiB.');
    for (let attempt = 0; attempt < 4; attempt++) {
      let result;
      try {
        result = await fetcher(`${origin}/__migration/${route}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: serialized, signal: AbortSignal.timeout(30000)
        });
      } catch {
        if (attempt === 3) throw new Error('Sem resposta da importação após quatro tentativas. Execute novamente para retomar.');
        await delay(250 * 2 ** attempt);
        continue;
      }
      const payload = await result.json().catch(() => null);
      if (result.ok) {
        if (!payload || typeof payload !== 'object') throw new Error('Resposta de importação inválida.');
        return payload;
      }
      if ([408, 429, 500, 502, 503, 504].includes(result.status) && attempt < 3) {
        await delay(250 * 2 ** attempt);
        continue;
      }
      // Remote errors are fixed strings; never print response bodies containing customer records.
      throw new Error(`A operação ${route} foi recusada (HTTP ${result.status}). Confira o token, o status e o arquivo; nenhuma publicação foi executada.`);
    }
  };
}
async function* jsonLines(filename) {
  const source = fs.createReadStream(filename);
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of source) {
      pending = Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline > MAX_BODY_BYTES) throw new Error('Uma linha do arquivo excede 8 MiB.');
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (!line.length) throw new Error('O arquivo contém uma linha vazia.');
        try { yield JSON.parse(line.toString('utf8')); }
        catch (error) { if (error instanceof SyntaxError) throw new Error('O arquivo contém JSON inválido.'); throw error; }
      }
      if (pending.length > MAX_BODY_BYTES) throw new Error('Uma linha do arquivo excede 8 MiB.');
    }
    if (pending.length) {
      try { yield JSON.parse(pending.toString('utf8')); }
      catch (error) { if (error instanceof SyntaxError) throw new Error('O arquivo contém JSON inválido.'); throw error; }
    }
  } finally { source.destroy(); }
}
function checkFileManifest(manifest) {
  if (!manifest || manifest.type !== 'manifest' || manifest.format !== FORMAT || !Array.isArray(manifest.tables)
      || manifest.tables.length !== TABLES.length
      || manifest.sha256 !== sha256(canonical({ format: manifest.format, tables: manifest.tables }))) {
    throw new Error('Manifesto inválido.');
  }
  for (let index = 0; index < TABLES.length; index++) {
    const table = manifest.tables[index];
    if (table.name !== TABLES[index] || !Array.isArray(table.columns) || !Number.isSafeInteger(table.count)
        || table.count < 0 || !/^[a-f0-9]{64}$/.test(table.sha256)) throw new Error('Tabela inválida no manifesto.');
  }
  return manifest;
}
async function inspectFile(filename) {
  const { createHash } = require('node:crypto');
  let manifest;
  let tableIndex = 0;
  const counts = Object.fromEntries(TABLES.map(table => [table, 0]));
  const hashes = Object.fromEntries(TABLES.map(table => [table, createHash('sha256')]));
  const previousKeys = {};
  for await (const entry of jsonLines(filename)) {
    if (!manifest) { manifest = checkFileManifest(entry); continue; }
    if (!entry || Object.keys(entry).sort().join(',') !== 'row,table,type' || entry.type !== 'row'
        || !TABLES.includes(entry.table) || !entry.row || Array.isArray(entry.row) || typeof entry.row !== 'object') {
      throw new Error('Linha de dados inválida.');
    }
    const currentIndex = TABLES.indexOf(entry.table);
    if (currentIndex < tableIndex) throw new Error('As tabelas do arquivo estão fora de ordem.');
    tableIndex = currentIndex;
    const key = entry.row[KEYS[entry.table]];
    const previous = previousKeys[entry.table];
    const expectedType = KEYS[entry.table] === 'id' ? 'number' : 'string';
    if (typeof key !== expectedType || (expectedType === 'number' && !Number.isSafeInteger(key))
        || (previous !== undefined && (typeof key === 'number' ? key <= previous : Buffer.compare(Buffer.from(key), Buffer.from(previous)) <= 0))) {
      throw new Error('Identificadores inválidos ou fora de ordem.');
    }
    previousKeys[entry.table] = key;
    counts[entry.table]++;
    hashes[entry.table].update(canonical(entry.row)).update('\n');
  }
  if (!manifest) throw new Error('Arquivo vazio.');
  for (const table of manifest.tables) {
    if (table.count !== counts[table.name] || table.sha256 !== hashes[table.name].digest('hex')) {
      throw new Error(`Contagem ou hash divergente na tabela ${table.name}.`);
    }
  }
  return manifest;
}
async function exportData(options) {
  const { DatabaseSync } = require('node:sqlite');
  const filename = path.resolve(options.out || DEFAULT_FILE);
  const dbPath = options.db ? path.resolve(options.db)
    : path.resolve(__dirname, '..', process.env.DB_FILE || 'loja.db');
  assertSafeOutput(dbPath, filename);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const temporary = `${filename}.partial-${process.pid}-${Date.now()}`;
  let output;
  let failure;
  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('BEGIN');
    const manifest = createManifest(db);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    output.on('error', error => { failure = error; });
    const write = async value => {
      const line = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(line) > MAX_BODY_BYTES) throw new Error('Uma linha do banco excede 8 MiB.');
      if (failure) throw failure;
      if (!output.write(line)) await once(output, 'drain');
    };
    await write(manifest);
    for (const table of manifest.tables) {
      const read = db.prepare(`SELECT * FROM ${table.name} WHERE ${KEYS[table.name]} = ?`);
      for (const key of rowKeys(db, table.name)) {
        await write({ type: 'row', table: table.name, row: encodeRow(read.get(key[KEYS[table.name]]), table.columns) });
      }
    }
    output.end();
    await once(output, 'finish');
    if (failure) throw failure;
    db.exec('COMMIT');
    fs.renameSync(temporary, filename);
    return { file: filename, session: manifest.sha256, counts: Object.fromEntries(manifest.tables.map(table => [table.name, table.count])) };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* A failure can precede BEGIN. */ }
    if (output) output.destroy();
    try { fs.unlinkSync(temporary); } catch { /* The temporary file might not exist. */ }
    throw error;
  } finally { db.close(); }
}
async function importData(options, fetcher, token = process.env.IMPORT_TOKEN) {
  const filename = path.resolve(options.file || DEFAULT_FILE);
  const manifest = await inspectFile(filename);
  const call = migrationClient(destination(options.url), token, fetcher);
  const before = await call('status');
  if (before.ready) {
    if (before.session !== manifest.sha256) throw new Error('O destino já está ativo com outra importação.');
    return before;
  }
  if (before.session && before.session !== manifest.sha256) throw new Error('O destino possui outra importação em andamento.');
  await call('begin', { manifest });
  for await (const entry of jsonLines(filename)) {
    if (entry.type === 'manifest') continue;
    await call('row', { session: manifest.sha256, table: entry.table, row: entry.row });
  }
  return call('commit', { session: manifest.sha256 });
}
async function main(argv = process.argv.slice(2)) {
  const options = argsFrom(argv);
  if (options.command === 'export') {
    try { process.loadEnvFile(path.join(__dirname, '..', '.env')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const token = options.command === 'export' ? undefined : await readImportToken();
  const result = options.command === 'export' ? await exportData(options)
    : options.command === 'import' ? await importData(options, undefined, token)
      : await migrationClient(destination(options.url), token)('status');
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error(`Migração: ${error.message}`); process.exitCode = 1; });
module.exports = { argsFrom, destination, migrationClient, jsonLines, inspectFile, exportData, importData, assertSafeOutput, readImportToken, main };
