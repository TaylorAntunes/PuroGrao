const express = require('express');
const { db } = require('../database');
const { periodStart } = require('../dashboard');
const { orderProfit } = require('../../shared/profitability');

// Mounted after administrative authentication. This endpoint only reads snapshots.
const router = express.Router();
const channels = ['all', 'whatsapp', 'in_person'];
const statuses = ['all', 'novo', 'confirmado', 'pago', 'entregue', 'cancelado'];
const allowedQuery = new Set(['search', 'channel', 'status', 'from', 'to', 'offset', 'limit']);
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
db.function('puro_sales_history_text', { deterministic: true }, normalize);

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return null;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

router.get('/', (req, res) => {
  const query = req.query;
  if (Object.entries(query).some(([key, value]) => !allowedQuery.has(key) || typeof value !== 'string')) {
    return res.status(400).json({ error: 'Informe apenas um valor de texto para cada filtro.' });
  }
  const channel = query.channel ?? 'whatsapp';
  const status = query.status ?? 'all';
  const search = query.search ?? '';
  if (!channels.includes(channel) || !statuses.includes(status) || search.length > 120) {
    return res.status(400).json({ error: 'Os filtros de vendas são inválidos.' });
  }
  const offset = query.offset === undefined ? 0 : /^\d+$/.test(query.offset) ? Number(query.offset) : NaN;
  const limit = query.limit === undefined ? 25 : /^\d+$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return res.status(400).json({ error: 'Informe uma página válida e de 1 a 100 vendas por página.' });
  }
  const from = query.from === undefined ? null : validDate(query.from);
  const to = query.to === undefined ? null : validDate(query.to);
  if ((query.from !== undefined && !from) || (query.to !== undefined && !to) || (from && to && from > to)) {
    return res.status(400).json({ error: 'Informe datas válidas; a data inicial deve vir antes da final.' });
  }

  const clauses = [];
  const parameters = [];
  if (channel !== 'all') { clauses.push('sales_channel=?'); parameters.push(channel); }
  if (status !== 'all') { clauses.push('status=?'); parameters.push(status); }
  if (from) { clauses.push('julianday(created_at)>=julianday(?)'); parameters.push(periodStart(from, 'day')); }
  if (to) {
    // A UTC noon represents the same local day, including São Paulo's historical DST.
    const nextDay = new Date(to.getTime() + 24 * 3600000);
    // Bind the boundary numerically so even 9999-12-31 has a valid exclusive end.
    const endJulianDay = Date.parse(periodStart(nextDay, 'day')) / 86400000 + 2440587.5;
    clauses.push('julianday(created_at)<?'); parameters.push(endJulianDay);
  }
  const text = normalize(search.trim());
  if (text) {
    const numeric = /^#?\d+$/.test(text) ? Number(text.replace(/^#/, '')) : NaN;
    const id = Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
    clauses.push('(id=? OR INSTR(puro_sales_history_text(customer),?)>0 OR INSTR(puro_sales_history_text(phone),?)>0)');
    parameters.push(id, text, text);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  // Aggregate orders directly; joining their items here would duplicate revenue.
  const summary = db.prepare(`SELECT COUNT(*) AS orders,
    COALESCE(SUM(status IN ('pago','entregue')),0) AS sales_orders,
    COALESCE(SUM(CASE WHEN status IN ('pago','entregue') THEN total_cents ELSE 0 END),0) AS sales_cents,
    COALESCE(SUM(status IN ('novo','confirmado')),0) AS pending_orders,
    COALESCE(SUM(status='cancelado'),0) AS cancelled_orders FROM orders ${where}`).get(...parameters);
  summary.average_ticket_cents = summary.sales_orders ? Math.round(summary.sales_cents / summary.sales_orders) : 0;
  const orders = db.prepare(`SELECT * FROM orders ${where}
    ORDER BY julianday(created_at) DESC,id DESC LIMIT ? OFFSET ?`).all(...parameters, limit, offset);
  if (orders.length) {
    const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${orders.map(() => '?').join(',')})
      ORDER BY id`).all(...orders.map(order => order.id));
    const itemsByOrder = new Map();
    for (const item of items) {
      if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
      itemsByOrder.get(item.order_id).push(item);
    }
    orders.forEach(order => {
      order.items = itemsByOrder.get(order.id) || [];
      order.profit = orderProfit(order.items);
    });
  }
  res.json({ orders, total: summary.orders, offset, limit, summary });
});

module.exports = router;
