const PROMOTION_TIMEZONE = 'America/Sao_Paulo';
const weekday = new Intl.DateTimeFormat('en-US', { timeZone: PROMOTION_TIMEZONE, weekday: 'short' });
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: PROMOTION_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function endOfLocalDay(now) {
  const date = localDate.format(now);
  let low = now.getTime();
  let high = low + 36 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = Math.floor((high + low) / 2);
    if (localDate.format(new Date(middle)) === date) low = middle;
    else high = middle;
  }
  return new Date(high).toISOString();
}

function promotionState(now = new Date()) {
  const active = weekday.format(now) === 'Tue';
  return {
    name: 'Terça do Granel',
    active,
    discount_percent: 20,
    timezone: PROMOTION_TIMEZONE,
    server_now: now.toISOString(),
    ends_at: active ? endOfLocalDay(now) : null,
  };
}

const discountFor = (product, promotion) => product.sale_unit !== 'unit' && product.tuesday_promo && promotion.active ? promotion.discount_percent : 0;

module.exports = { promotionState, discountFor };
