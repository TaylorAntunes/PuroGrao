const express = require('express');
const { createHash, randomUUID } = require('node:crypto');
const { MAX_WEIGHT_GRAMS, portionPrice, isUnit, stockAmount, formatAmount, cartKey } = require('../pricing');
const { IMAGE_URL_SQL } = require('../product-images');
const { promotionState, discountFor } = require('../promotions');
const { shippingFor, FREE_SHIPPING_MIN_CENTS } = require('../shipping');
const { readBanner } = require('../banner');
const { objectBody } = require('../middleware/http');
const { nextOrderId } = require('../inventory');
const { portionCost } = require('../../shared/profitability');
const { createOrderLimits } = require('../order-limits');
const { PRODUCT_ORDER_SQL } = require('../product-order');

function createRouter({ db, transaction, env = process.env, state = {} }) {
  const router = express.Router();
  const orderLimits = createOrderLimits({ entries: state.orders, windowMs: env.ORDER_RATE_WINDOW_MS, maxNew: env.ORDER_RATE_MAX_NEW, maxAttempts: env.ORDER_RATE_MAX_ATTEMPTS, maxIps: env.ORDER_RATE_MAX_IPS });
  const requestUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const whatsappNumber = (env.WHATSAPP_NUMBER || '5500000000000').replace(/\D/g, '');
  const formatBrl = cents => (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });

  router.get('/products', (_, res) => {
    const promotion = promotionState();
    const bestSellers = db.prepare(`SELECT oi.product_id FROM order_items oi
      JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
      WHERE o.status IN ('pago', 'entregue') AND p.active = 1
      GROUP BY oi.product_id ORDER BY COUNT(DISTINCT o.id) DESC, SUM(oi.qty) DESC, oi.product_id ASC LIMIT 4`).all();
    const ranks = new Map(bestSellers.map((product, index) => [product.product_id, index + 1]));
    const products = db.prepare(
      `SELECT id, name, description, price_cents, price_weight_grams, sale_unit, stock_units, category, color, stock_grams, tuesday_promo, is_new, image_position_x, image_position_y, image_fit, display_order, ${IMAGE_URL_SQL} FROM products WHERE active = 1 ORDER BY ${PRODUCT_ORDER_SQL}`
    ).all().map(product => ({ ...product, discount_percent: discountFor(product, promotion), best_seller_rank: ranks.get(product.id) || null }));
    res.set('Cache-Control', 'no-store');
    const kits = db.prepare('SELECT * FROM kits WHERE active=1 ORDER BY id DESC').all()
      .map(kit => ({ id: kit.id, name: kit.name, description: kit.description, components: JSON.parse(kit.components) }))
      .filter(kit => kit.components.every(item => products.some(product => product.id === item.id && product.sale_unit === (item.sale_unit || 'weight'))));
    const banner = readBanner(db);
    res.json({ products, kits, promotion, banner: banner.active ? banner : null, shipping: { free_shipping_min_cents: FREE_SHIPPING_MIN_CENTS, city: 'Maracanaú' }, whatsapp: whatsappNumber, max_weight_grams: MAX_WEIGHT_GRAMS });
  });

  router.get('/products/:id/image', (req, res) => {
    const product = db.prepare('SELECT image_data, image_mime, image_version FROM products WHERE id = ?').get(req.params.id);
    if (!product?.image_data) return res.status(404).json({ error: 'Imagem não encontrada.' });
    res.set({
      'Content-Type': product.image_mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': req.query.v === product.image_version ? 'public, max-age=86400' : 'no-cache',
      ETag: `"${product.image_version}"`,
    });
    res.send(Buffer.from(product.image_data));
  });

  router.post('/orders', orderLimits.attempt, express.json({ limit: '50kb' }), objectBody, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body || {};
    const { customer, phone, address, notes, items, expected_total_cents } = body;
    const promotion = promotionState();
    const badRequest = message => res.status(400).json({ error: message });
    if (body.request_id !== undefined && (typeof body.request_id !== 'string' || !requestUuid.test(body.request_id))) {
      return badRequest('Identificação do pedido inválida. Atualize a página e tente novamente.');
    }
    if (typeof customer !== 'string' || ['phone', 'address', 'notes', 'delivery_city'].some(key => body[key] !== undefined && typeof body[key] !== 'string')) {
      return badRequest('Informe os dados do cliente e da entrega como textos.');
    }
    const deliveryMethod = body.delivery_method ?? (String(address || '').trim() ? 'delivery' : 'pickup');
    const deliveryCity = String(body.delivery_city || '').trim().slice(0, 80);
    if (!['delivery', 'pickup'].includes(deliveryMethod)) return badRequest('Escolha entrega ou retirada.');
    if (body.delivery_method === 'delivery' && (!deliveryCity || !String(address || '').trim())) return badRequest('Informe a cidade e o endereço de entrega.');

    if (!String(customer || '').trim()) return badRequest('Informe seu nome.');
    if (expected_total_cents !== undefined && (!Number.isSafeInteger(expected_total_cents) || expected_total_cents < 0)) return badRequest('Informe um total válido.');
    if (!Array.isArray(items) || !items.length || items.length > 50) {
      return badRequest('Carrinho vazio.');
    }

    const quantities = new Map();
    const productQuantities = new Map();
    for (const item of items) {
      const unit = item?.sale_unit === 'unit';
      if (!item || !Number.isSafeInteger(item.id) || item.id < 1 ||
          !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 99 ||
          (item.sale_unit !== undefined && !['weight', 'unit'].includes(item.sale_unit)) ||
          (unit ? item.weight_grams !== undefined && item.weight_grams !== 0 : !Number.isInteger(item.weight_grams) || item.weight_grams < 1 || item.weight_grams > MAX_WEIGHT_GRAMS)) {
        return badRequest('Informe até 99 unidades ou porções por produto. Para produtos por peso, use de 1 a 100.000 gramas inteiras.');
      }
      const quantity = (productQuantities.get(item.id) || 0) + item.qty;
      if (quantity > 99) return badRequest('O limite por produto é de 99 unidades.');
      productQuantities.set(item.id, quantity);
      const key = cartKey(item);
      const previous = quantities.get(key);
      quantities.set(key, { id: item.id, sale_unit: unit ? 'unit' : 'weight', grams: unit ? 0 : item.weight_grams, quantity: (previous?.quantity || 0) + item.qty });
    }

    const cut = (value, length) => String(value || '').trim().slice(0, length);
    // Legacy clients get an internal key solely to retain their order ID after deletion.
    const requestId = body.request_id?.toLowerCase() || randomUUID();
    const requestHash = createHash('sha256').update(JSON.stringify({
      customer: cut(customer, 80), phone: cut(phone, 30), address: cut(address, 200), notes: cut(notes, 300),
      delivery_method: deliveryMethod, delivery_city: deliveryCity, expected_total_cents: expected_total_cents ?? null,
      items: [...quantities.values()].sort((a, b) => a.id - b.id || a.grams - b.grams || a.sale_unit.localeCompare(b.sale_unit)),
    })).digest('hex');
    try {
      const result = transaction(() => {
        if (body.request_id !== undefined) {
          const previous = db.prepare('SELECT * FROM public_order_requests WHERE request_id=?').get(requestId);
          if (previous) {
            if (previous.request_hash !== requestHash) throw Object.assign(new Error('Esta identificação já foi usada em outro pedido. Inicie um novo pedido.'),
              { status: 409, code: 'ORDER_REQUEST_CONFLICT' });
            const order = db.prepare('SELECT status FROM orders WHERE id=?').get(previous.order_id);
            if (!order) throw Object.assign(new Error('Este pedido já foi excluído. Inicie um novo pedido se desejar comprar novamente.'),
              { status: 409, code: 'ORDER_REQUEST_DELETED' });
            if (order.status === 'cancelado') throw Object.assign(new Error('Este pedido foi cancelado. Inicie um novo pedido se desejar comprar novamente.'),
              { status: 409, code: 'ORDER_REQUEST_CANCELLED' });
            return { ...JSON.parse(previous.response_json), duplicate: true, status: order.status };
          }
        }
        orderLimits.assertCreation(req.ip);
        const lines = [];
        const consumedByProduct = new Map();
        const findProduct = db.prepare('SELECT id, name, price_cents, cost_cents, price_weight_grams, sale_unit, stock_units, stock_grams, tuesday_promo FROM products WHERE id = ? AND active = 1');
        for (const { id, sale_unit, grams, quantity } of quantities.values()) {
          const product = findProduct.get(id);
          if (!product) {
            throw Object.assign(new Error('Um item do carrinho não está mais disponível.'), { status: 409 });
          }
          if (product.sale_unit !== sale_unit) {
            throw Object.assign(new Error(`A forma de venda de ${product.name} mudou. Atualize o carrinho e escolha novamente.`), { status: 409 });
          }
          const consumed = grams * quantity;
          const units = isUnit(product) ? quantity : 0;
          const requested = (consumedByProduct.get(id) || 0) + (isUnit(product) ? units : consumed);
          consumedByProduct.set(id, requested);
          if (requested > stockAmount(product)) {
            throw Object.assign(new Error(`Estoque insuficiente para ${product.name}. Disponível: ${formatAmount(product, stockAmount(product))}.`), { status: 409 });
          }
          lines.push({ product, quantity, grams, consumed, units, price: portionPrice({ ...product, discount_percent: discountFor(product, promotion) }, grams) });
        }
        const total = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
        if (!Number.isSafeInteger(total)) {
          throw Object.assign(new Error('O total excede o limite permitido. Reduza as quantidades do pedido.'), { status: 400 });
        }
        if (expected_total_cents !== undefined && expected_total_cents !== total) {
          throw Object.assign(new Error('Os preços ou a promoção mudaram. Atualizamos seu pedido; confira o novo total e envie novamente.'), { status: 409 });
        }
        const shipping = shippingFor(total, deliveryMethod, deliveryCity);
        const id = nextOrderId(db);
        db.prepare(
          'INSERT INTO orders(id, customer, phone, address, notes, total_cents, stock_deducted, delivery_method, delivery_city, free_shipping) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)'
        ).run(id, cut(customer, 80), cut(phone, 30), cut(address, 200), cut(notes, 300), total, deliveryMethod, deliveryCity, Number(shipping.free));
        const insertItem = db.prepare(
          'INSERT INTO order_items(order_id, product_id, name, qty, price_cents, cost_cents, weight_grams, stock_grams, sale_unit, stock_units) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        lines.forEach(line => insertItem.run(
          id,
          line.product.id,
          line.product.name,
          line.quantity,
          line.price,
          portionCost(line.product, line.grams),
          line.grams,
          line.consumed,
          line.product.sale_unit,
          line.units
        ));
        const message = `Olá! Fiz o pedido #${id} no site:\n` +
          lines.map(line => `• ${line.quantity}x ${line.product.name} (${formatAmount(line.product, isUnit(line.product) ? 1 : line.grams)}) – ${formatBrl(line.price * line.quantity)}`).join('\n') +
          `\n\nTotal: ${formatBrl(total)}\nNome: ${cut(customer, 80)}\nEntrega/retirada: ${cut(address, 200) || 'retirada na loja'}` +
          `\n${shipping.method === 'pickup' ? 'Retirada na loja' : shipping.free ? 'Frete grátis para Maracanaú' : `Frete a combinar${shipping.city ? ` · ${shipping.city}` : ''}`}` +
          (cut(notes, 300) ? `\nObs.: ${cut(notes, 300)}` : '') + '\n\nComo faço o pagamento?';
        const response = { id, total_cents: total, shipping,
          whatsapp_url: `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`, duplicate: false };
        // Pending online orders keep snapshots; inventory is deducted on staff confirmation.
        db.prepare('INSERT INTO public_order_requests(request_id,request_hash,order_id,response_json) VALUES(?,?,?,?)')
          .run(requestId, requestHash, id, JSON.stringify(response));
        return response;
      });
      if (!result.duplicate) orderLimits.recordCreation(req.ip);
      res.json(result);
    } catch (error) {
      if (error.status) {
        if (error.retry_after_seconds) res.set('Retry-After', String(error.retry_after_seconds));
        return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      throw error;
    }
  });

  return router;
}

module.exports = createRouter;
