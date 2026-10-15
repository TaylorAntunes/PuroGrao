// Native SQLite remains available to npm start. Workers always inject StorageDatabase.
class DatabaseSync {
  constructor() { throw new Error('Use o banco persistente do Durable Object no Cloudflare Workers.'); }
}
module.exports = { DatabaseSync };
