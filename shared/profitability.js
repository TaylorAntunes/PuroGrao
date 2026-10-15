// Costs use reais per kg for weight products and reais per piece for units.
(function (root) {
  const portionCost = (product, grams) => {
    if (product.cost_cents == null) return null;
    const unit = product.sale_unit === 'unit';
    const denominator = unit ? 1n : 1000n;
    return Number((BigInt(product.cost_cents) * BigInt(unit ? 1 : grams) + denominator / 2n) / denominator);
  };
  const marginPercent = (revenue, cost) => revenue > 0 && cost != null ? (revenue - cost) / revenue * 100 : null;
  const orderProfit = items => {
    if (!items.length || items.some(item => item.cost_cents == null)) return null;
    const revenue = items.reduce((sum, item) => sum + item.price_cents * item.qty, 0);
    const cost = items.reduce((sum, item) => sum + item.cost_cents * item.qty, 0);
    return { cost_cents: cost, profit_cents: revenue - cost, margin_percent: marginPercent(revenue, cost) };
  };
  const profitability = { portionCost, marginPercent, orderProfit };
  if (typeof module === 'object' && module.exports) module.exports = profitability;
  else root.PuroProfitability = profitability;
})(globalThis);
