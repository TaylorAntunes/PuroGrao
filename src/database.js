const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { initializeDatabase } = require('./database-schema');
const { runTransaction } = require('./transactions');

const db = new DatabaseSync(path.resolve(__dirname, '..', process.env.DB_FILE || 'loja.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
initializeDatabase(db);
const transaction = callback => runTransaction(db, callback);

module.exports = { db, transaction };
