// Call inside the same transaction that changed the stock. Entries are immutable.
function recordMovement(db, product, { sale_unit = product.sale_unit, delta, reason, note = '', order_id = null }) {
  if (delta === 0 && reason !== 'initial') return;
  const balance = db.prepare('SELECT stock_grams, stock_units FROM products WHERE id=?').get(product.id);
  if (!balance) return;
  db.prepare(`INSERT INTO stock_movements(product_id, product_name, sale_unit, delta, balance, reason, note, order_id)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(product.id, product.name, sale_unit, delta, sale_unit === 'unit' ? balance.stock_units : balance.stock_grams, reason, note, order_id);
}

// SQLite can reuse a deleted highest ID; history must still identify the original item.
function nextProductId(db) {
  return db.prepare('SELECT MAX(id) + 1 AS id FROM (SELECT id FROM products UNION ALL SELECT product_id AS id FROM stock_movements)').get().id || 1;
}
function nextOrderId(db) {
  return db.prepare(`SELECT MAX(id) + 1 AS id FROM (SELECT id FROM orders
    UNION ALL SELECT order_id AS id FROM stock_movements
    UNION ALL SELECT order_id AS id FROM public_order_requests
    UNION ALL SELECT order_id AS id FROM in_person_sale_requests)`).get().id || 1;
}

module.exports = { recordMovement, nextProductId, nextOrderId };
