// Keep one catalog order across the shop, filtered lists and administration.
const PRODUCT_ORDER_SQL = 'CASE WHEN display_order > 0 THEN 0 ELSE 1 END, display_order, category, name, id';

function orderedProductIds(db) {
  return db.prepare(`SELECT id FROM products ORDER BY ${PRODUCT_ORDER_SQL}`).all().map(product => product.id);
}

function nextDisplayOrder(db) {
  const order = db.prepare('SELECT COALESCE(MAX(display_order), 0) AS maximum FROM products').get().maximum + 1;
  if (!Number.isSafeInteger(order)) throw new Error('A ordem dos produtos excede o limite permitido.');
  return order;
}

function moveProduct(db, id, position, expectedOrder) {
  const current = orderedProductIds(db);
  if (!current.includes(id)) throw Object.assign(new Error('Produto não encontrado.'), { status: 404 });
  if (current.length !== expectedOrder.length || current.some((productId, index) => productId !== expectedOrder[index])) {
    throw Object.assign(new Error('A lista de produtos mudou. Atualize a lista antes de reorganizar.'), { status: 409 });
  }
  const ordered = current.filter(productId => productId !== id);
  ordered.splice(position - 1, 0, id);
  const update = db.prepare('UPDATE products SET display_order=? WHERE id=?');
  ordered.forEach((productId, index) => update.run(index + 1, productId));
}

module.exports = { PRODUCT_ORDER_SQL, orderedProductIds, nextDisplayOrder, moveProduct };
