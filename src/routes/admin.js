const express = require('express');
const { MAX_WEIGHT_GRAMS, MAX_PRICE_CENTS } = require('../pricing');
const { IMAGE_URL_SQL, decodeProductImage, imageLayout } = require('../product-images');
const { cleanKit } = require('../kits');
const { cleanBanner, readBanner } = require('../banner');
const { getDashboard } = require('../dashboard');
const { createAuth } = require('../auth');
const { objectBody } = require('../middleware/http');
const { recordMovement, nextProductId } = require('../inventory');
const { orderProfit } = require('../../shared/profitability');
const { PRODUCT_ORDER_SQL, nextDisplayOrder, moveProduct } = require('../product-order');

function createRouter({ db, transaction, env = process.env, state = {} }) {
  const router = express.Router();
  const auth = createAuth(env.ADMIN_PASSWORD || 'trocar-esta-senha', state.auth);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.post('/login', express.json({ limit: '50kb' }), objectBody, auth.login);

  const cleanProduct = (body = {}, previous = {}) => ({
    name: String(body.name || '').trim().slice(0, 80),
    description: String(body.description || '').slice(0, 200),
    price_cents: Math.round(Number(body.price) * 100),
    cost_cents: body.cost === undefined
      ? (body.sale_unit !== undefined && body.sale_unit !== previous.sale_unit ? null : previous.cost_cents ?? null)
      : body.cost === null ? null : Math.round(body.cost * 100),
    category: String(body.category || 'Geral').trim().slice(0, 30) || 'Geral',
    color: /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#B98A4B',
    active: body.active === undefined ? 1 : typeof body.active === 'boolean' ? Number(body.active) : NaN,
    sale_unit: body.sale_unit ?? previous.sale_unit ?? 'weight',
    stock_units: (body.sale_unit ?? previous.sale_unit) === 'unit' ? (typeof body.stock_units === 'number' ? body.stock_units : NaN) : (previous.stock_units ?? 0),
    stock_grams: (body.sale_unit ?? previous.sale_unit) === 'unit' ? (previous.stock_grams ?? 0) : (typeof body.stock_grams === 'number' ? body.stock_grams : NaN),
    price_weight_grams: (body.sale_unit ?? previous.sale_unit) === 'unit' ? (previous.price_weight_grams ?? 1000) : (typeof body.price_weight_grams === 'number' ? body.price_weight_grams : NaN),
    tuesday_promo: body.tuesday_promo === undefined ? null : typeof body.tuesday_promo === 'boolean' ? Number(body.tuesday_promo) : NaN,
    is_new: body.is_new === undefined ? null : typeof body.is_new === 'boolean' ? Number(body.is_new) : NaN,
  });
  const isValidProduct = product => product.name &&
    ['weight', 'unit'].includes(product.sale_unit) &&
    Number.isSafeInteger(product.stock_units) && product.stock_units >= 0 &&
    [0, 1].includes(product.active) &&
    Number.isSafeInteger(product.price_cents) && product.price_cents >= 0 && product.price_cents <= MAX_PRICE_CENTS &&
    (product.cost_cents === null || Number.isSafeInteger(product.cost_cents) && product.cost_cents >= 0 && product.cost_cents <= MAX_PRICE_CENTS) &&
    Number.isSafeInteger(product.stock_grams) && product.stock_grams >= 0 &&
    Number.isInteger(product.price_weight_grams) && product.price_weight_grams > 0 && product.price_weight_grams <= MAX_WEIGHT_GRAMS &&
    (product.tuesday_promo === null || [0, 1].includes(product.tuesday_promo)) &&
    (product.is_new === null || [0, 1].includes(product.is_new));

  function productBody(req, res, next) {
    const body = req.body || {};
    if (typeof body.name !== 'string' || typeof body.price !== 'number' ||
        ['description', 'category'].some(key => body[key] !== undefined && typeof body[key] !== 'string') ||
        (body.sale_unit !== undefined && !['weight', 'unit'].includes(body.sale_unit))) {
      return res.status(400).json({ error: 'Informe nome, descrição e categoria como textos e preço como número.' });
    }
    if (body.cost !== undefined && body.cost !== null && (typeof body.cost !== 'number' || !Number.isFinite(body.cost) || body.cost < 0 || body.cost > MAX_PRICE_CENTS / 100)) {
      return res.status(400).json({ error: 'Informe um custo válido em reais ou deixe o custo vazio.' });
    }
    next();
  }

  router.use(auth.authenticate);
  router.post('/logout', auth.logout);
  // Read larger image payloads only after authentication; other endpoints keep their existing limit.
  router.use('/products', express.json({ limit: '7mb' }));
  router.use(express.json({ limit: '50kb' }));
  router.use(objectBody);
  router.use('/stock-movements', require('./inventory')({ db, transaction }));
  router.use('/sales', require('./sales')({ db, transaction }));
  router.use('/sales-history', require('./sales-history')({ db, transaction }));

  router.get('/dashboard', (_, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(getDashboard(db));
  });
  router.get('/banner', (_, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ banner: readBanner(db) });
  });
  router.put('/banner', (req, res) => {
    const banner = cleanBanner(req.body);
    db.prepare(`INSERT INTO site_banner(id, active, title, description, link_label, link_url)
      VALUES(1, @active, @title, @description, @link_label, @link_url)
      ON CONFLICT(id) DO UPDATE SET active=excluded.active, title=excluded.title,
        description=excluded.description, link_label=excluded.link_label, link_url=excluded.link_url`)
      .run({ ...banner, active: Number(banner.active) });
    res.json({ banner: readBanner(db) });
  });

  router.get('/kits', (_, res) => {
    res.json({ kits: db.prepare('SELECT * FROM kits ORDER BY id DESC').all().map(kit => ({ ...kit, components: JSON.parse(kit.components) })) });
  });
  router.post('/kits', (req, res) => {
    const kit = cleanKit(req.body, db);
    const result = db.prepare('INSERT INTO kits(name, description, active, components) VALUES(@name, @description, @active, @components)').run(kit);
    res.json({ id: result.lastInsertRowid });
  });
  router.put('/kits/:id', (req, res) => {
    const kit = cleanKit(req.body, db);
    const result = db.prepare('UPDATE kits SET name=@name, description=@description, active=@active, components=@components WHERE id=@id').run({ ...kit, id: req.params.id });
    if (!result.changes) return res.status(404).json({ error: 'Kit não encontrado.' });
    res.json({ ok: true });
  });
  router.delete('/kits/:id', (req, res) => {
    if (!db.prepare('DELETE FROM kits WHERE id=?').run(req.params.id).changes) return res.status(404).json({ error: 'Kit não encontrado.' });
    res.json({ ok: true });
  });

  router.get('/products', (_, res) => {
    const products = db.prepare(`SELECT id, name, description, price_cents, cost_cents, price_weight_grams, sale_unit, stock_units, category, color, active, stock_grams, tuesday_promo, is_new, image_position_x, image_position_y, image_fit, display_order, ${IMAGE_URL_SQL} FROM products ORDER BY ${PRODUCT_ORDER_SQL}`).all()
      .map(product => ({ ...product, price: product.price_cents / 100, cost: product.cost_cents === null ? null : product.cost_cents / 100 }));
    res.json({ products });
  });

  router.post('/products', productBody, (req, res) => {
    const product = cleanProduct(req.body);
    if (!isValidProduct(product)) {
      return res.status(400).json({ error: 'Informe nome, preço válido e estoque inteiro. Escolha peso com referência em gramas ou venda por unidade.' });
    }
    const image = decodeProductImage(req.body.image_data_url ?? null);
    const layout = imageLayout(req.body);
    const id = transaction(() => {
      const id = nextProductId(db);
      const displayOrder = nextDisplayOrder(db);
      db.prepare(
        `INSERT INTO products(id, name, description, price_cents, cost_cents, price_weight_grams, sale_unit, stock_units, category, color, active, stock_grams, tuesday_promo, is_new, image_data, image_mime, image_version, image_position_x, image_position_y, image_fit, display_order)
          VALUES(@id, @name, @description, @price_cents, @cost_cents, @price_weight_grams, @sale_unit, @stock_units, @category, @color, @active, @stock_grams, COALESCE(@tuesday_promo, 0), COALESCE(@is_new, 0), @image_data, @image_mime, @image_version, COALESCE(@image_position_x, 50), COALESCE(@image_position_y, 50), COALESCE(@image_fit, 'cover'), @display_order)`
      ).run({ ...product, ...image, ...layout, id, display_order: displayOrder });
      recordMovement(db, { ...product, id }, { delta: product.sale_unit === 'unit' ? product.stock_units : product.stock_grams, reason: 'initial', note: 'Estoque informado no cadastro do produto.' });
      return id;
    });
    res.json({ id });
  });

  router.patch('/products/:id/order', (req, res) => {
    const id = Number(req.params.id);
    const { position, expected_order: expectedOrder } = req.body;
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(position) || position < 1 ||
        !Array.isArray(expectedOrder) || position > expectedOrder.length ||
        expectedOrder.some(productId => !Number.isSafeInteger(productId) || productId < 1) ||
        new Set(expectedOrder).size !== expectedOrder.length) {
      return res.status(400).json({ error: 'Informe uma posição válida e a lista atual dos produtos.' });
    }
    try {
      transaction(() => moveProduct(db, id, position, expectedOrder));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    res.json({ ok: true, id, position });
  });

  router.put('/products/:id', productBody, (req, res) => {
    const previous = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
    if (!previous) return res.status(404).json({ error: 'Produto não encontrado.' });
    const product = cleanProduct(req.body, previous);
    if (!isValidProduct(product)) {
      return res.status(400).json({ error: 'Informe nome, preço válido e estoque inteiro. Escolha peso com referência em gramas ou venda por unidade.' });
    }
    const replaceImage = Object.hasOwn(req.body, 'image_data_url');
    const image = decodeProductImage(replaceImage ? req.body.image_data_url : null);
    const layout = imageLayout(req.body);
    transaction(() => {
      db.prepare(
      `UPDATE products SET name=@name, description=@description, price_cents=@price_cents, cost_cents=@cost_cents, price_weight_grams=@price_weight_grams, sale_unit=@sale_unit, stock_units=@stock_units, category=@category, color=@color, active=@active, stock_grams=@stock_grams,
        tuesday_promo=COALESCE(@tuesday_promo, tuesday_promo), is_new=COALESCE(@is_new, is_new),
        image_data=CASE WHEN @replace_image THEN @image_data ELSE image_data END,
        image_mime=CASE WHEN @replace_image THEN @image_mime ELSE image_mime END,
        image_version=CASE WHEN @replace_image THEN @image_version ELSE image_version END,
        image_position_x=COALESCE(@image_position_x, image_position_x),
        image_position_y=COALESCE(@image_position_y, image_position_y),
        image_fit=COALESCE(@image_fit, image_fit) WHERE id=@id`
    ).run({ ...product, ...image, ...layout, replace_image: replaceImage ? 1 : 0, id: req.params.id });
      const updated = { ...product, id: previous.id };
      const note = previous.sale_unit !== product.sale_unit ? 'Estoque definido ao alterar a forma de venda; não houve conversão automática.' : 'Estoque alterado no cadastro do produto.';
      recordMovement(db, updated, { sale_unit: 'weight', delta: product.stock_grams - previous.stock_grams, reason: 'product_edit', note });
      recordMovement(db, updated, { sale_unit: 'unit', delta: product.stock_units - previous.stock_units, reason: 'product_edit', note });
    });
    res.json({ ok: true });
  });

  router.delete('/products/:id', (req, res) => {
    if (db.prepare('SELECT components FROM kits').all().some(kit => JSON.parse(kit.components).some(item => item.id === Number(req.params.id)))) return res.status(409).json({ error: 'Este produto faz parte de um kit. Remova-o do kit antes de excluir.' });
    if (db.prepare('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1').get(req.params.id)) {
      return res.status(409).json({ error: 'Este produto tem pedidos. Desmarque "Visível na loja" para ocultá-lo e preservar o controle de estoque.' });
    }
    if (!db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id).changes) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.json({ ok: true });
  });

  router.get('/orders', (_, res) => {
    const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all();
    const items = db.prepare(
      'SELECT * FROM order_items WHERE order_id IN (SELECT id FROM orders ORDER BY id DESC LIMIT 200)'
    ).all();
    orders.forEach(order => {
      order.items = items.filter(item => item.order_id === order.id);
      order.profit = orderProfit(order.items);
    });
    res.json({ orders });
  });

  router.delete('/orders/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Pedido inválido.' });
    const deleted = transaction(() => {
      if (!db.prepare('SELECT 1 FROM orders WHERE id = ?').get(id)) return false;
      // Removing history does not cancel a sale or change its inventory deduction.
      db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
      // Keep retry protection while removing the saved WhatsApp text and customer details.
      db.prepare("UPDATE public_order_requests SET response_json='{}' WHERE order_id=?").run(id);
      db.prepare('DELETE FROM orders WHERE id = ?').run(id);
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json({ ok: true });
  });

  router.patch('/orders/:id', (req, res) => {
    const statuses = ['novo', 'confirmado', 'pago', 'entregue', 'cancelado'];
    if (!statuses.includes(req.body?.status)) {
      return res.status(400).json({ error: 'Status inválido.' });
    }
    try {
      transaction(() => {
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
        if (!order) throw Object.assign(new Error('Pedido não encontrado.'), { status: 404 });
        const cancel = req.body.status === 'cancelado';
        // Legacy orders did not deduct stock and must never return it on cancellation.
        if (cancel && order.stock_deducted) {
          const items = db.prepare('SELECT product_id, SUM(stock_grams) AS grams, SUM(stock_units) AS units FROM order_items WHERE order_id = ? GROUP BY product_id').all(order.id);
          for (const item of items) {
            const product = db.prepare('SELECT id, name, sale_unit, stock_grams, stock_units FROM products WHERE id = ?').get(item.product_id);
            if (product && (!Number.isSafeInteger(product.stock_grams + item.grams) || !Number.isSafeInteger(product.stock_units + item.units))) {
              throw Object.assign(new Error('O estoque resultante excede o limite permitido.'), { status: 409 });
            }
            db.prepare('UPDATE products SET stock_grams = stock_grams + ?, stock_units = stock_units + ? WHERE id = ?').run(item.grams, item.units, item.product_id);
            if (product) {
              recordMovement(db, product, { sale_unit: 'weight', delta: item.grams, reason: 'cancellation', order_id: order.id });
              recordMovement(db, product, { sale_unit: 'unit', delta: item.units, reason: 'cancellation', order_id: order.id });
            }
          }
          db.prepare('UPDATE orders SET stock_deducted = 0 WHERE id = ?').run(order.id);
        } else if (!cancel && !order.stock_deducted && ['confirmado', 'pago', 'entregue'].includes(req.body.status)) {
          // Old cancelled orders acquire a gram snapshot only when first reopened.
          db.prepare(`UPDATE order_items SET stock_grams = qty * COALESCE(NULLIF(weight_grams, 0),
            (SELECT price_weight_grams FROM products WHERE id = order_items.product_id), 1000)
            WHERE order_id = ? AND stock_grams = 0 AND sale_unit='weight'`).run(order.id);
          const items = db.prepare('SELECT product_id, sale_unit, SUM(stock_grams) AS grams, SUM(stock_units) AS units FROM order_items WHERE order_id = ? GROUP BY product_id, sale_unit').all(order.id);
          for (const item of items) {
            const result = db.prepare('UPDATE products SET stock_grams = stock_grams - ?, stock_units = stock_units - ? WHERE id = ? AND sale_unit = ? AND stock_grams >= ? AND stock_units >= ?')
              .run(item.grams, item.units, item.product_id, item.sale_unit, item.grams, item.units);
            if (!result.changes) {
              throw Object.assign(new Error('Estoque insuficiente ou forma de venda alterada. Confira os produtos antes de confirmar ou reabrir este pedido.'), { status: 409 });
            }
            const product = db.prepare('SELECT id, name, sale_unit FROM products WHERE id=?').get(item.product_id);
            recordMovement(db, product, { delta: -(item.sale_unit === 'unit' ? item.units : item.grams),
              reason: order.status === 'cancelado' ? 'reopening' : 'sale', order_id: order.id });
          }
          db.prepare('UPDATE orders SET stock_deducted = 1 WHERE id = ?').run(order.id);
        }
        db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(req.body.status, order.id);
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    res.json({ ok: true });
  });

  router.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: req.path.startsWith('/products') ? 'A imagem deve ter no máximo 5 MB.' : 'Os dados enviados excedem o limite permitido.' });
    if (error.status === 400) return res.status(400).json({ error: error.type === 'entity.parse.failed' ? 'Os dados enviados são inválidos.' : error.message });
    next(error);
  });

  return router;
}

module.exports = createRouter;
