const FREE_SHIPPING_MIN_CENTS = 5000;
const normalizeCity = city => String(city || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function shippingFor(total, method, city) {
  const free = method === 'delivery' && normalizeCity(city) === 'maracanau' && total >= FREE_SHIPPING_MIN_CENTS;
  return { method, city, free, minimum_cents: FREE_SHIPPING_MIN_CENTS };
}

module.exports = { FREE_SHIPPING_MIN_CENTS, shippingFor };
