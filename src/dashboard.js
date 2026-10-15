const TIMEZONE = 'America/Sao_Paulo';
const { marginPercent } = require('../shared/profitability');
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function calendarKey(date, period) {
  const parts = Object.fromEntries(calendar.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}${period === 'day' ? `-${parts.day}` : ''}`;
}

// Find UTC boundaries from the local calendar, including historical DST changes.
function periodStart(now, period) {
  const key = calendarKey(now, period);
  let low = now.getTime() - (period === 'day' ? 36 : 35 * 24) * 3600000;
  let high = now.getTime();
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (calendarKey(new Date(middle), period) === key) high = middle;
    else low = middle;
  }
  return new Date(high).toISOString();
}

function getDashboard(db, now = new Date()) {
  const dayStart = periodStart(now, 'day');
  const monthStart = periodStart(now, 'month');
  const summarize = db.prepare(`SELECT COUNT(*) AS orders,
    COALESCE(SUM(status IN ('pago', 'entregue')), 0) AS sales_orders,
    COALESCE(SUM(CASE WHEN status IN ('pago', 'entregue') THEN total_cents ELSE 0 END), 0) AS sales_cents,
    COALESCE(SUM(status IN ('novo', 'confirmado')), 0) AS pending_orders,
    COALESCE(SUM(status='cancelado'), 0) AS cancelled_orders
    FROM orders WHERE julianday(created_at) >= julianday(?) AND julianday(created_at) <= julianday(?)`);
  const summary = start => {
    const result = summarize.get(start, now.toISOString());
    return { ...result, average_ticket_cents: result.sales_orders ? Math.round(result.sales_cents / result.sales_orders) : 0 };
  };
  const bestSellers = db.prepare(`SELECT oi.product_id, COALESCE(p.name, MAX(oi.name)) AS name,
    COUNT(DISTINCT o.id) AS orders, SUM(oi.qty) AS portions,
    SUM(oi.qty * oi.weight_grams) AS weight_grams,
    SUM(CASE WHEN oi.sale_unit='unit' THEN oi.qty ELSE 0 END) AS units,
    SUM(CASE WHEN oi.sale_unit='weight' THEN oi.qty ELSE 0 END) AS weight_portions,
    SUM(oi.qty * oi.price_cents) AS sales_cents
    FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN products p ON p.id=oi.product_id
    WHERE o.status IN ('pago','entregue') AND julianday(o.created_at) >= julianday(?) AND julianday(o.created_at) <= julianday(?)
    GROUP BY oi.product_id ORDER BY orders DESC, portions DESC, oi.product_id ASC LIMIT 5`).all(monthStart, now.toISOString());
  const stock = db.prepare(`SELECT COUNT(*) AS low_stock,
    COALESCE(SUM(CASE WHEN sale_unit='unit' THEN stock_units=0 ELSE stock_grams=0 END),0) AS sold_out
    FROM products WHERE (sale_unit='weight' AND stock_grams <= 3000) OR (sale_unit='unit' AND stock_units <= 3)`).get();
  const profits = start => {
    const orders = db.prepare(`SELECT o.id, o.total_cents,
      COUNT(oi.id) AS items, SUM(oi.cost_cents IS NULL) AS missing_costs,
      SUM(oi.cost_cents * oi.qty) AS cost_cents
      FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id
      WHERE o.status IN ('pago','entregue') AND julianday(o.created_at)>=julianday(?) AND julianday(o.created_at)<=julianday(?)
      GROUP BY o.id`).all(start, now.toISOString());
    const known = orders.filter(order => order.items > 0 && !order.missing_costs);
    const revenue = known.reduce((sum, order) => sum + order.total_cents, 0);
    const cost = known.reduce((sum, order) => sum + order.cost_cents, 0);
    return { known_orders: known.length, unknown_orders: orders.length - known.length, sales_cents: revenue,
      cost_cents: cost, profit_cents: known.length ? revenue - cost : null, margin_percent: marginPercent(revenue, known.length ? cost : null) };
  };
  return { timezone: TIMEZONE, updated_at: now.toISOString(), day: summary(dayStart), month: summary(monthStart), stock, best_sellers: bestSellers,
    profit: { day: profits(dayStart), month: profits(monthStart) } };
}

module.exports = { getDashboard, periodStart };
