const express = require('express');
const { createHash } = require('node:crypto');
const { MAX_WEIGHT_GRAMS, portionPrice, isUnit, stockAmount, formatAmount, cartKey } = require('../pricing');
const { IMAGE_URL_SQL } = require('../product-images');
const { promotionState, discountFor } = require('../promotions');
const { recordMovement, nextOrderId } = require('../inventory');
const { portionCost, orderProfit } = require('../../shared/profitability');

// Mounted after the admin router's authentication and JSON validation.
function createRouter({ db, transaction }) {
  const router = express.Router();
  const paymentMethods = ['pix', 'dinheiro', 'cartao', 'outro'];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });

  router.get('/', (_, res) => {
    const promotion = promotionState();
    // Visibility controls the online catalogue only; counter sales can use hidden products.
    const products = db.prepare(`SELECT id, name, description, price_cents, price_weight_grams,
      sale_unit, stock_units, stock_grams, category, color, active, tuesday_promo, image_position_x,
      image_position_y, image_fit, ${IMAGE_URL_SQL} FROM products ORDER BY category, name`).all()
      .map(product => ({ ...product, discount_percent: discountFor(product, promotion) }));
    const sales = db.prepare("SELECT * FROM orders WHERE sales_channel='in_person' ORDER BY id DESC LIMIT 50").all();
    const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN
      (SELECT id FROM orders WHERE sales_channel='in_person' ORDER BY id DESC LIMIT 50)`).all();
    sales.forEach(sale => {
      sale.items = items.filter(item => item.order_id === sale.id);
      sale.profit = orderProfit(sale.items);
    });
    res.json({ products, promotion, max_weight_grams: MAX_WEIGHT_GRAMS, sales });
  });

  router.post('/', (req, res) => {
    const body = req.body || {};
    if (typeof body.request_id !== 'string' || !uuid.test(body.request_id)) {
      return res.status(400).json({ error: 'Identificação da venda inválida. Atualize o painel e tente novamente.' });
    }
    if (!paymentMethods.includes(body.payment_method)) return res.status(400).json({ error: 'Escolha a forma de pagamento.' });
    if (['customer', 'notes'].some(key => body[key] !== undefined && typeof body[key] !== 'string')) {
      return res.status(400).json({ error: 'Informe o nome e as observações como textos.' });
    }
    if (!Number.isSafeInteger(body.expected_total_cents) || body.expected_total_cents < 0) {
      return res.status(400).json({ error: 'Confira o total da venda antes de registrar.' });
    }
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) {
      return res.status(400).json({ error: 'Adicione produtos à venda.' });
    }

    const quantities = new Map();
    const productQuantities = new Map();
    for (const item of body.items) {
      const unit = item?.sale_unit === 'unit';
      if (!item || !Number.isSafeInteger(item.id) || item.id < 1 ||
          !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 99 ||
          (item.sale_unit !== undefined && !['weight', 'unit'].includes(item.sale_unit)) ||
          (unit ? item.weight_grams !== undefined && item.weight_grams !== 0 :
            !Number.isInteger(item.weight_grams) || item.weight_grams < 1 || item.weight_grams > MAX_WEIGHT_GRAMS)) {
        return res.status(400).json({ error: 'Use até 99 unidades ou porções por produto e pesos inteiros de 1 a 100.000 gramas.' });
      }
      const quantity = (productQuantities.get(item.id) || 0) + item.qty;
      if (quantity > 99) return res.status(400).json({ error: 'O limite por produto é de 99 unidades ou porções.' });
      productQuantities.set(item.id, quantity);
      const key = cartKey(item);
      const previous = quantities.get(key);
      quantities.set(key, { id: item.id, sale_unit: unit ? 'unit' : 'weight', grams: unit ? 0 : item.weight_grams,
        quantity: (previous?.quantity || 0) + item.qty });
    }

    const requestId = body.request_id.toLowerCase();
    const customer = (body.customer || '').trim().slice(0, 80) || 'Cliente presencial';
    const notes = (body.notes || '').trim().slice(0, 300);
    const requestHash = createHash('sha256').update(JSON.stringify({ customer, notes,
      payment_method: body.payment_method, expected_total_cents: body.expected_total_cents,
      items: [...quantities.values()].sort((a, b) => a.id - b.id || a.grams - b.grams || a.sale_unit.localeCompare(b.sale_unit)) })).digest('hex');
    const promotion = promotionState();

    try {
      const result = transaction(() => {
        const previous = db.prepare('SELECT * FROM in_person_sale_requests WHERE request_id=?').get(requestId);
        if (previous) {
          if (previous.request_hash !== requestHash) throw fail('Esta identificação já foi usada por outra venda. Inicie uma nova venda.', 409);
          const order = db.prepare('SELECT status FROM orders WHERE id=?').get(previous.order_id);
          return { id: previous.order_id, total_cents: previous.total_cents,
            status: order?.status || 'pago', sales_channel: 'in_person', payment_method: body.payment_method,
            duplicate: true, deleted: !order };
        }

        const lines = [];
        const findProduct = db.prepare(`SELECT id, name, price_cents, cost_cents, price_weight_grams,
          sale_unit, stock_units, stock_grams, tuesday_promo FROM products WHERE id=?`);
        const deductStock = db.prepare(`UPDATE products SET stock_grams=stock_grams-?, stock_units=stock_units-?
          WHERE id=? AND stock_grams>=? AND stock_units>=?`);
        for (const { id, sale_unit, grams, quantity } of quantities.values()) {
          const product = findProduct.get(id);
          if (!product) throw fail('Um produto não está mais cadastrado. Atualize a venda.', 409);
          if (product.sale_unit !== sale_unit) throw fail(`A forma de venda de ${product.name} mudou. Escolha a quantidade novamente.`, 409);
          const consumed = grams * quantity;
          const units = isUnit(product) ? quantity : 0;
          if (!deductStock.run(consumed, units, id, consumed, units).changes) {
            throw fail(`Estoque insuficiente para ${product.name}. Disponível: ${formatAmount(product, stockAmount(product))}.`, 409);
          }
          lines.push({ product, grams, quantity, consumed, units,
            price: portionPrice({ ...product, discount_percent: discountFor(product, promotion) }, grams) });
        }
        const total = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
        if (!Number.isSafeInteger(total)) throw fail('O total excede o limite permitido. Reduza as quantidades.');
        if (total !== body.expected_total_cents) throw fail('O preço ou a promoção mudou. Confira o total atualizado antes de registrar a venda.', 409);

        const orderId = nextOrderId(db);
        db.prepare(`INSERT INTO orders(id, customer, phone, address, notes, total_cents, status,
          stock_deducted, delivery_method, delivery_city, free_shipping, sales_channel, payment_method)
          VALUES (?, ?, '', '', ?, ?, 'pago', 1, 'pickup', '', 0, 'in_person', ?)`)
          .run(orderId, customer, notes, total, body.payment_method);
        const insertItem = db.prepare(`INSERT INTO order_items(order_id, product_id, name, qty,
          price_cents, cost_cents, weight_grams, stock_grams, sale_unit, stock_units)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        lines.forEach(line => insertItem.run(orderId, line.product.id, line.product.name, line.quantity,
          line.price, portionCost(line.product, line.grams), line.grams, line.consumed, line.product.sale_unit, line.units));
        for (const productId of new Set(lines.map(line => line.product.id))) {
          const matching = lines.filter(line => line.product.id === productId);
          const product = matching[0].product;
          recordMovement(db, product, { delta: -matching.reduce((sum, line) => sum + (isUnit(product) ? line.units : line.consumed), 0),
            reason: 'sale', order_id: orderId, note: 'Venda presencial registrada no painel.' });
        }
        // Keep this record when an order is deleted so retries never create a second sale.
        db.prepare('INSERT INTO in_person_sale_requests(request_id, request_hash, order_id, total_cents) VALUES (?, ?, ?, ?)')
          .run(requestId, requestHash, orderId, total);
        return { id: orderId, total_cents: total, status: 'pago', sales_channel: 'in_person',
          payment_method: body.payment_method, duplicate: false };
      });
      res.json(result);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });

  return router;
}

module.exports = createRouter;
