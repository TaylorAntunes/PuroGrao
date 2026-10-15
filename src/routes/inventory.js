const express = require('express');
const { db, transaction } = require('../database');
const { recordMovement } = require('../inventory');
const router = express.Router();
const reasons = ['initial', 'purchase', 'manual_adjustment', 'product_edit', 'sale', 'cancellation', 'reopening'];

router.get('/', (req, res) => {
  const product = req.query.product_id === undefined ? null : Number(req.query.product_id);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  const reason = req.query.reason ?? '';
  if ((product !== null && (!Number.isSafeInteger(product) || product < 1)) ||
      !Number.isSafeInteger(offset) || offset < 0 || (reason && !reasons.includes(reason)) || typeof reason !== 'string') {
    return res.status(400).json({ error: 'Filtros de movimentação inválidos.' });
  }
  const filter = 'WHERE (? IS NULL OR product_id=?) AND (?=\'\' OR reason=?)';
  const params = [product, product, reason, reason];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM stock_movements ${filter}`).get(...params).count;
  const pageOffset = Math.min(offset, Math.max(0, Math.floor((total - 1) / 50) * 50));
  const movements = db.prepare(`SELECT * FROM stock_movements ${filter} ORDER BY id DESC LIMIT 50 OFFSET ?`).all(...params, pageOffset);
  const products = db.prepare(`SELECT m.product_id AS id, COALESCE(p.name, m.product_name) AS name, p.id IS NULL AS deleted
    FROM stock_movements m LEFT JOIN products p ON p.id=m.product_id
    WHERE m.id IN (SELECT MAX(id) FROM stock_movements GROUP BY product_id) ORDER BY name`).all();
  res.json({ movements, total, offset: pageOffset, limit: 50, products });
});

router.post('/', (req, res) => {
  const { product_id, sale_unit, delta, reason, note } = req.body;
  if (!Number.isSafeInteger(product_id) || product_id < 1 || !['weight', 'unit'].includes(sale_unit) ||
      !Number.isSafeInteger(delta) || delta === 0 || !['purchase', 'manual_adjustment'].includes(reason) ||
      (reason === 'purchase' && delta < 1) || typeof note !== 'string' || !note.trim() || note.length > 300) {
    return res.status(400).json({ error: 'Escolha produto, medida, quantidade inteira e motivo. Compras devem ser entradas; descreva a movimentação em até 300 caracteres.' });
  }
  const result = transaction(() => {
    const product = db.prepare('SELECT id, name, sale_unit, stock_units, stock_grams FROM products WHERE id=?').get(product_id);
    if (!product) return { status: 404, error: 'Produto não encontrado.' };
    if (product.sale_unit !== sale_unit) return { status: 409, error: 'A forma de venda mudou. Atualize o painel antes de movimentar o estoque.' };
    const field = sale_unit === 'unit' ? 'stock_units' : 'stock_grams';
    const balance = product[field] + delta;
    if (!Number.isSafeInteger(balance) || balance < 0) return { status: 409, error: 'A movimentação deixaria o estoque negativo ou excederia o limite permitido.' };
    db.prepare(`UPDATE products SET ${field}=? WHERE id=?`).run(balance, product_id);
    recordMovement(db, product, { delta, reason, note: note.trim() });
    return { balance };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, balance: result.balance });
});

module.exports = router;
