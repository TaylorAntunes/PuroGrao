const { recordMovement } = require('./inventory');
const { runTransaction } = require('./transactions');

function initializeDatabase(db, { seed = true } = {}) {
  return runTransaction(db, () => {
    const startingHistory = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stock_movements'").get();
    const startingProductOrder = !db.prepare('PRAGMA table_info(products)').all().some(column => column.name === 'display_order');
    db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        price_cents INTEGER NOT NULL,
        category TEXT DEFAULT 'Geral',
        color TEXT DEFAULT '#B98A4B',
        active INTEGER DEFAULT 1,
        display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0),
        stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
        stock_grams INTEGER NOT NULL DEFAULT 0 CHECK(stock_grams >= 0),
        price_weight_grams INTEGER NOT NULL DEFAULT 1000 CHECK(price_weight_grams > 0),
        image_data BLOB,
        image_mime TEXT NOT NULL DEFAULT '',
        image_version TEXT NOT NULL DEFAULT '',
        image_position_x INTEGER NOT NULL DEFAULT 50 CHECK(image_position_x BETWEEN 0 AND 100),
        image_position_y INTEGER NOT NULL DEFAULT 50 CHECK(image_position_y BETWEEN 0 AND 100),
        image_fit TEXT NOT NULL DEFAULT 'cover' CHECK(image_fit IN ('cover', 'contain'))
      );
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        customer TEXT,
        phone TEXT,
        address TEXT,
        notes TEXT,
        total_cents INTEGER,
        status TEXT DEFAULT 'novo',
        stock_deducted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY,
        order_id INTEGER,
        product_id INTEGER,
        name TEXT,
        qty INTEGER,
        price_cents INTEGER,
        weight_grams INTEGER NOT NULL DEFAULT 0,
        stock_grams INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS kits (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        components TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS site_banner (
        id INTEGER PRIMARY KEY CHECK(id=1),
        active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        link_label TEXT NOT NULL DEFAULT '',
        link_url TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS order_items_product ON order_items(product_id);
      CREATE TABLE IF NOT EXISTS stock_movements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL,
        product_name TEXT NOT NULL,
        sale_unit TEXT NOT NULL CHECK(sale_unit IN ('weight', 'unit')),
        delta INTEGER NOT NULL,
        balance INTEGER NOT NULL CHECK(balance >= 0),
        reason TEXT NOT NULL CHECK(reason IN ('initial', 'purchase', 'manual_adjustment', 'product_edit', 'sale', 'cancellation', 'reopening')),
        note TEXT NOT NULL DEFAULT '',
        order_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS stock_movements_product ON stock_movements(product_id, id);
      CREATE INDEX IF NOT EXISTS stock_movements_order ON stock_movements(order_id);
      CREATE TABLE IF NOT EXISTS in_person_sale_requests (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS public_order_requests (
        request_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        order_id INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Upgrade existing databases without changing products or historical orders.
    if (!db.prepare('PRAGMA table_info(products)').all().some(column => column.name === 'stock')) {
      db.exec('ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0)');
    }
    if (!db.prepare('PRAGMA table_info(orders)').all().some(column => column.name === 'stock_deducted')) {
      db.exec('ALTER TABLE orders ADD COLUMN stock_deducted INTEGER NOT NULL DEFAULT 0');
    }
    const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map(column => column.name);
    if (!orderColumns.includes('delivery_method')) {
      db.exec("ALTER TABLE orders ADD COLUMN delivery_method TEXT NOT NULL DEFAULT 'pickup'");
      if (orderColumns.includes('address')) db.exec("UPDATE orders SET delivery_method='delivery' WHERE LENGTH(TRIM(COALESCE(address, ''))) > 0");
    }
    if (!orderColumns.includes('delivery_city')) db.exec("ALTER TABLE orders ADD COLUMN delivery_city TEXT NOT NULL DEFAULT ''");
    if (!orderColumns.includes('free_shipping')) db.exec('ALTER TABLE orders ADD COLUMN free_shipping INTEGER NOT NULL DEFAULT 0');
    if (!orderColumns.includes('sales_channel')) db.exec("ALTER TABLE orders ADD COLUMN sales_channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK(sales_channel IN ('whatsapp', 'in_person'))");
    if (!orderColumns.includes('payment_method')) db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''");
    const productColumns = db.prepare('PRAGMA table_info(products)').all().map(column => column.name);
    if (!productColumns.includes('display_order')) db.exec('ALTER TABLE products ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0 CHECK(display_order >= 0)');
    if (!productColumns.includes('cost_cents')) db.exec('ALTER TABLE products ADD COLUMN cost_cents INTEGER CHECK(cost_cents >= 0)');
    if (!productColumns.includes('sale_unit')) db.exec("ALTER TABLE products ADD COLUMN sale_unit TEXT NOT NULL DEFAULT 'weight' CHECK(sale_unit IN ('weight', 'unit'))");
    if (!productColumns.includes('stock_units')) db.exec('ALTER TABLE products ADD COLUMN stock_units INTEGER NOT NULL DEFAULT 0 CHECK(stock_units >= 0)');
    if (!productColumns.includes('tuesday_promo')) db.exec('ALTER TABLE products ADD COLUMN tuesday_promo INTEGER NOT NULL DEFAULT 0 CHECK(tuesday_promo IN (0, 1))');
    if (!productColumns.includes('is_new')) db.exec('ALTER TABLE products ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0 CHECK(is_new IN (0, 1))');
    if (!productColumns.includes('image_data')) db.exec('ALTER TABLE products ADD COLUMN image_data BLOB');
    if (!productColumns.includes('image_mime')) db.exec("ALTER TABLE products ADD COLUMN image_mime TEXT NOT NULL DEFAULT ''");
    if (!productColumns.includes('image_version')) db.exec("ALTER TABLE products ADD COLUMN image_version TEXT NOT NULL DEFAULT ''");
    if (!productColumns.includes('image_position_x')) db.exec('ALTER TABLE products ADD COLUMN image_position_x INTEGER NOT NULL DEFAULT 50 CHECK(image_position_x BETWEEN 0 AND 100)');
    if (!productColumns.includes('image_position_y')) db.exec('ALTER TABLE products ADD COLUMN image_position_y INTEGER NOT NULL DEFAULT 50 CHECK(image_position_y BETWEEN 0 AND 100)');
    if (!productColumns.includes('image_fit')) db.exec("ALTER TABLE products ADD COLUMN image_fit TEXT NOT NULL DEFAULT 'cover' CHECK(image_fit IN ('cover', 'contain'))");
    if (!productColumns.includes('price_weight_grams')) {
      db.exec('ALTER TABLE products ADD COLUMN price_weight_grams INTEGER NOT NULL DEFAULT 1000 CHECK(price_weight_grams > 0)');
      const updateWeight = db.prepare('UPDATE products SET price_weight_grams = ? WHERE id = ?');
      for (const product of db.prepare('SELECT id, description FROM products').all()) {
        const match = product.description?.match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
        const grams = match ? Math.round(Number(match[1].replace(',', '.')) * (match[2].toLowerCase() === 'kg' ? 1000 : 1)) : 1000;
        updateWeight.run(Number.isSafeInteger(grams) && grams > 0 ? grams : 1000, product.id);
      }
    }
    const migratingStock = !productColumns.includes('stock_grams');
    if (migratingStock) {
      db.exec('ALTER TABLE products ADD COLUMN stock_grams INTEGER NOT NULL DEFAULT 0 CHECK(stock_grams >= 0)');
      for (const product of db.prepare('SELECT stock, price_weight_grams FROM products').all()) {
        if (!Number.isSafeInteger(product.stock * product.price_weight_grams)) {
          throw new Error('O estoque antigo excede o limite seguro de conversão para gramas.');
        }
      }
      db.exec('UPDATE products SET stock_grams = stock * price_weight_grams');
    }
    const itemColumns = db.prepare('PRAGMA table_info(order_items)').all().map(column => column.name);
    // Historical orders keep unknown costs; never infer them from current products.
    if (!itemColumns.includes('cost_cents')) db.exec('ALTER TABLE order_items ADD COLUMN cost_cents INTEGER CHECK(cost_cents >= 0)');
    if (!itemColumns.includes('sale_unit')) db.exec("ALTER TABLE order_items ADD COLUMN sale_unit TEXT NOT NULL DEFAULT 'weight' CHECK(sale_unit IN ('weight', 'unit'))");
    if (!itemColumns.includes('stock_units')) db.exec('ALTER TABLE order_items ADD COLUMN stock_units INTEGER NOT NULL DEFAULT 0 CHECK(stock_units >= 0)');
    if (!itemColumns.includes('weight_grams')) {
      db.exec('ALTER TABLE order_items ADD COLUMN weight_grams INTEGER NOT NULL DEFAULT 0');
    }
    if (!itemColumns.includes('stock_grams')) {
      db.exec('ALTER TABLE order_items ADD COLUMN stock_grams INTEGER NOT NULL DEFAULT 0');
      // Snapshot the original stock deduction, while preserving historical prices and labels.
      db.exec(`UPDATE order_items SET stock_grams = qty * COALESCE(
        (SELECT price_weight_grams FROM products WHERE id = order_items.product_id), 1000)
        WHERE order_id IN (SELECT id FROM orders WHERE stock_deducted = 1)`);
    }

    if (seed && !db.prepare('SELECT COUNT(*) AS count FROM products').get().count) {
      const insertProduct = db.prepare(
        'INSERT INTO products(name, description, price_cents, category, color, price_weight_grams) VALUES (?, ?, ?, ?, ?, ?)'
      );
      [
        ['Granola artesanal', 'Aveia, castanhas e coco. 400 g', 2400, 'Grãos', '#B98A4B'],
        ['Quinoa em grãos', 'Real, lavada e pronta. 500 g', 2800, 'Grãos', '#B98A4B'],
        ['Linhaça dourada', 'Rica em fibras. 250 g', 1200, 'Grãos', '#B98A4B'],
        ['Castanha-do-pará', 'A granel, por 100 g', 1800, 'Castanhas', '#7A5230'],
        ['Amêndoas', 'Sem sal, por 100 g', 2200, 'Castanhas', '#7A5230'],
        ['Mel puro', 'Direto do apicultor. 350 g', 3200, 'Doces', '#C8963E'],
        ['Açaí em pó', 'Liofilizado, sem aditivos. 200 g', 2900, 'Doces', '#4A2150'],
        ['Chá de hibisco', 'Flores secas. 100 g', 1200, 'Chás', '#8A2E3F'],
        ['Capim-limão', 'Folhas secas. 50 g', 1000, 'Chás', '#4F7A45'],
      ].forEach(product => {
        const grams = Number(product[1].match(/(\d+)\s*g\b/)[1]);
        insertProduct.run(...product, grams);
      });
    }
    if (startingProductOrder) {
      // Capture the previous catalog order once; future starts preserve manual choices.
      const updateOrder = db.prepare('UPDATE products SET display_order=? WHERE id=?');
      const legacyOrder = ['category', 'name', 'id'].filter(column => productColumns.includes(column)).join(', ');
      db.prepare(`SELECT id FROM products ORDER BY ${legacyOrder}`).all()
        .forEach((product, index) => updateOrder.run(index + 1, product.id));
    }
    if (startingHistory) {
      for (const product of db.prepare('SELECT id, name, sale_unit, stock_grams, stock_units FROM products').all()) {
        recordMovement(db, product, { delta: product.sale_unit === 'unit' ? product.stock_units : product.stock_grams,
          reason: 'initial', note: 'Saldo na implantação do histórico. Movimentações anteriores não foram reconstruídas.' });
        const other = product.sale_unit === 'unit' ? 'weight' : 'unit';
        const amount = other === 'unit' ? product.stock_units : product.stock_grams;
        if (amount) recordMovement(db, product, { sale_unit: other, delta: amount, reason: 'initial', note: 'Saldo preservado na outra medida.' });
      }
    }
  });
}

module.exports = { initializeDatabase };
