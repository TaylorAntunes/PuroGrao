// Shared by the server and browser to keep cent rounding identical.
(function (root) {
  const MAX_WEIGHT_GRAMS = 100000;
  const MAX_PRICE_CENTS = 1000000000;
  const isUnit = product => product.sale_unit === 'unit';
  const stockAmount = product => isUnit(product) ? product.stock_units : product.stock_grams;
  const formatUnits = quantity => `${quantity.toLocaleString('pt-BR')} ${quantity === 1 ? 'unidade' : 'unidades'}`;
  const formatAmount = (product, amount) => isUnit(product) ? formatUnits(amount) : formatWeight(amount);
  const cartKey = item => `${item.id}:${item.sale_unit === 'unit' ? 'unit' : item.weight_grams}`;
  const portionPrice = (product, grams) => {
    const denominator = BigInt(isUnit(product) ? 1 : product.price_weight_grams) * 100n;
    const numerator = BigInt(product.price_cents) * BigInt(isUnit(product) ? 1 : grams) * BigInt(100 - (product.discount_percent || 0));
    return Number((numerator + denominator / 2n) / denominator);
  };
  const formatWeight = grams => grams >= 1000
    ? `${(grams / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kg`
    : `${grams} g`;
  
  const pricing = { MAX_WEIGHT_GRAMS, MAX_PRICE_CENTS, portionPrice, formatWeight, isUnit, stockAmount, formatUnits, formatAmount, cartKey };
  if (typeof module === "object" && module.exports) module.exports = pricing;
  else root.PuroPricing = pricing;
})(globalThis);
