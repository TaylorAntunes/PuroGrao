const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function storefront(savedCart, stock, imageUrl = '', layout = {}, options = {}) {
  const elements = new Map();
  const listeners = new Map();
  const weights = [100, 250, 500, 1000, 'custom'].map(weight => ({ dataset: { weight: String(weight) }, disabled: false, setAttribute() {} }));
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', disabled: false, value: '', style: {},
      querySelector: element,
      querySelectorAll: () => [], focus() {}, setAttribute() {},
    });
    return elements.get(selector);
  };
  const card = {
    dataset: { product: '1' },
    querySelector: element,
    querySelectorAll: () => weights,
  };
  const add = element('[data-add]');
  add.dataset = { add: '1' };
  add.closest = () => card;
  let stored = JSON.stringify(savedCart);
  const session = new Map();
  let available = stock;
  const location = { href: '' };
  const context = vm.createContext({
    crypto: require('node:crypto').webcrypto,
    ProductSearch: require('../public/js/search'),
    PuroPricing: require('../shared/pricing'),
    addEventListener: (event, listener) => listeners.set(event, listener),
    document: {
      body: { dataset: { page: options.offersPage ? 'offers' : '' } },
      querySelector: selector => selector.startsWith('[data-product=') ? card : element(selector),
      querySelectorAll: selector => selector === '.card' ? [card] : [],
      addEventListener() {},
    },
    localStorage: { getItem: () => stored, setItem: (_, value) => { stored = value; } },
    sessionStorage: {
      getItem: key => (options.session || session).get(key) || null,
      setItem: (key, value) => (options.session || session).set(key, value),
      removeItem: key => (options.session || session).delete(key),
    },
    setTimeout() {}, clearTimeout() {}, location,
    FormData: class { get(name) { return name === 'customer' ? 'Cliente' : ''; } },
    fetch: async (url, config) => url === '/api/products' ? {
      ok: true,
      json: async () => ({ whatsapp: '5585999999999', kits: options.kits || [], products: options.products || [{ id: 1, name: 'Granola', description: '', category: 'Grãos', color: '#B98A4B', price_cents: 2400, price_weight_grams: 400, stock_grams: available, image_url: imageUrl, ...layout }] }),
    } : options.submit ? options.submit(url, config) : { ok: false, status: 409, json: async () => ({ error: 'Estoque insuficiente.' }) },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/store.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    element, add, location,
    visible: () => !card.hidden,
    cart: () => JSON.parse(stored),
    setStock: value => { available = value; },
    setProduct: value => { Object.assign(layout, value); },
    refreshCatalog: () => vm.runInContext('checkPromotion()', context),
    setSavedCart: value => { stored = JSON.stringify(value); listeners.get('storage')({ key: 'puro-cart-weight-v1' }); },
    clickAdd: () => element('#grid').onclick({ target: { closest: () => add } }),
    clickKit: id => element('#ready-kits').onclick({ target: { closest: () => ({ dataset: { addKit: String(id) }, disabled: false }) } }),
    selectWeight: grams => element('#grid').oninput({ target: { matches: () => true, closest: () => card, value: String(grams) } }),
    selectQuantity: qty => element('#grid').oninput({ target: { matches: selector => selector === '[data-unit-quantity]', closest: () => card, value: String(qty) } }),
    stepQuantity: direction => {
      const button = element(`[data-unit-step="${direction}"]`);
      button.dataset = { unitStep: direction };
      button.closest = () => card;
      element('#grid').onclick({ target: { closest: () => button } });
    },
    changeQuantity: (action, key = '1:100') => element('#items').onclick({ target: { closest: () => ({ dataset: { key, action } }) } }),
  };
}
const portion = (grams, qty) => ({ id: 1, weight_grams: grams, qty });

test('manual catalog order keeps alphabetical categories and independent best-seller/new shelves', async () => {
  const product = (id, name, category, rank) => ({ id, name, category, best_seller_rank: rank,
    description: '', color: '#B98A4B', price_cents: 2400, price_weight_grams: 1000,
    sale_unit: 'weight', stock_grams: 5000, is_new: 1, discount_percent: 10, tuesday_promo: 0 });
  const products = [product(20, 'Farinha', 'Farinhas', 3), product(1, 'Castanha', 'Castanhas', 1), product(30, 'Hibisco', 'Chás', 2)];
  const store = await storefront({}, 5000, '', {}, { products });
  const ids = (html, attribute) => [...html.matchAll(new RegExp(attribute + '="(\\d+)"', 'g'))].map(match => Number(match[1]));
  assert.deepEqual(ids(store.element('#grid').innerHTML, 'data-product'), [20, 1, 30]);
  assert.deepEqual([...store.element('.filters').innerHTML.matchAll(/data-category="([^"]+)"/g)].map(match => match[1]), ['Todos', 'Castanhas', 'Chás', 'Farinhas']);
  assert.deepEqual(ids(store.element('#best-sellers').innerHTML, 'data-choose-product'), [1, 30, 20]);
  assert.deepEqual(ids(store.element('#new-products').innerHTML, 'data-choose-product'), [30, 20, 1]);
  assert.deepEqual(ids(store.element('#offer-products').innerHTML, 'data-choose-product'), [20, 1, 30]);
  const offers = await storefront({}, 5000, '', {}, { products, offersPage: true });
  assert.deepEqual(ids(offers.element('#grid').innerHTML, 'data-product'), [20, 1, 30]);
});

test('WhatsApp sharing follows the selected portion and active discount without adding to cart', async () => {
  const store = await storefront({}, 5000, '', { discount_percent: 20 });
  store.selectWeight(333);
  const url = new URL(store.element('[data-share-product]').href);
  assert.equal(url.origin, 'https://wa.me');
  const message = url.searchParams.get('text');
  assert.match(message, /Granola/);
  assert.match(message, /15,98/);
  assert.match(message, /333 g/);
  assert.match(message, /20% OFF hoje/);
  assert.match(message, /\/\?produto=1#product-1/);
  assert.deepEqual(store.cart(), {});
});

test('restored portions fit shared gram inventory and malformed carts are discarded', async () => {
  const store = await storefront({ '1:100': portion(100, 8) }, 250);
  assert.deepEqual(store.cart(), { '1:100': portion(100, 2) });
  assert.equal(store.add.disabled, true);
  assert.equal((await storefront(null, 250)).element('#co').hidden, true);
  assert.deepEqual((await storefront({ '1:100': { ...portion(100, 1), qty: 'bad' } }, 250)).cart(), {});
});

test('different portion weights use shared stock and prices update immediately', async () => {
  const store = await storefront({}, 1000);
  store.selectWeight(250); store.clickAdd();
  assert.equal(store.element('[data-portion-price]').textContent, (15).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  store.selectWeight(500); store.clickAdd();
  assert.deepEqual(store.cart(), { '1:250': portion(250, 1), '1:500': portion(500, 1) });
  assert.equal(store.add.disabled, true);
  store.selectWeight(250); store.clickAdd(); store.clickAdd();
  assert.deepEqual(store.cart(), { '1:250': portion(250, 2), '1:500': portion(500, 1) });
  store.changeQuantity('+', '1:500');
  assert.equal(store.cart()['1:500'].qty, 1);
});

test('custom weights reject fractions and calculate proportional cents', async () => {
  const store = await storefront({}, 2000);
  store.selectWeight(333);
  assert.equal(store.element('[data-portion-price]').textContent, (19.98).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  store.clickAdd();
  assert.deepEqual(store.cart(), { '1:333': portion(333, 1) });
  store.selectWeight(1.5); store.clickAdd();
  assert.equal(store.add.disabled, true);
  assert.equal(Object.keys(store.cart()).length, 1);
  assert.match(store.element('[data-product-error]').textContent, /inteiro/);
});

test('portion count caps at 99 and exhausted products cannot be added', async () => {
  const store = await storefront({ '1:100': portion(100, 99) }, 20000);
  store.clickAdd(); store.changeQuantity('+');
  assert.equal(store.cart()['1:100'].qty, 99);
  const empty = await storefront({}, 0);
  empty.clickAdd();
  assert.deepEqual(empty.cart(), {});
  assert.match(empty.element('#grid').innerHTML, /Esgotado/);
});

test('stock conflicts refresh availability and show the error after removing unavailable portions', async () => {
  const store = await storefront({ '1:100': portion(100, 1) }, 100);
  store.setStock(0);
  await store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.deepEqual(store.cart(), {});
  assert.equal(store.element('#co').hidden, true);
  assert.equal(store.element('#msg').textContent, 'Estoque insuficiente.');
  assert.equal(store.element('#send').disabled, false);
  assert.equal(store.location.href, '');
});

test('compact product cards keep category metadata, show kilogram prices and use saved photos', async () => {
  const withPhoto = await storefront({}, 5000, '/api/products/1/image?v=test');
  assert.match(withPhoto.element('#grid').innerHTML, /data-category="Grãos"/);
  assert.doesNotMatch(withPhoto.element('#grid').innerHTML, /stock-availability|product-category|Estoque disponível/);
  assert.match(withPhoto.element('#grid').innerHTML, /class="reference-price">[^<]*60,00<span class="reference-price-unit"> \/ kg<\/span>/);
  assert.match(withPhoto.element('#grid').innerHTML, /class="product-photo" src="\/api\/products\/1\/image\?v=test"/);
  const grams = await storefront({}, 750);
  assert.doesNotMatch(grams.element('#grid').innerHTML, /stock-availability|product-category|750 g/);
  assert.doesNotMatch(grams.element('#grid').innerHTML, /class="product-photo"/);
  const empty = await storefront({}, 0);
  assert.match(empty.element('#grid').innerHTML, /class="stock-tag sold-out">Esgotado<\/span>/);
  assert.equal(empty.add.disabled, true);
  const positioned = await storefront({}, 5000, '/api/products/1/image?v=test', { image_position_x: 20, image_position_y: 75, image_fit: 'contain' });
  assert.match(positioned.element('#grid').innerHTML, /object-position:20% 75%;object-fit:contain/);
  for (const priceWeight of [50, 100]) {
    const discounted = await storefront({}, 5000, '', { price_weight_grams: priceWeight, price_cents: priceWeight * 10, discount_percent: 20 });
    assert.match(discounted.element('#grid').innerHTML, /class="reference-price"><del>[^<]*100,00<\/del> <strong>[^<]*80,00<\/strong><span class="reference-price-unit"> \/ kg<\/span>/);
    assert.match(discounted.element('[data-portion-price]').textContent, /8,00/);
  }
});

test('Tuesday discounts match proportional cents in cards, highlights and cart', async () => {
  const store = await storefront({}, 5000, '', {
    price_cents: 1024, price_weight_grams: 1000, discount_percent: 20,
    tuesday_promo: 1, is_new: 1, best_seller_rank: 1,
  });
  store.selectWeight(25);
  store.clickAdd();
  const price = (.2).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  assert.equal(store.element('[data-portion-price]').textContent, price);
  assert.equal(store.element('#total').textContent, price);
  assert.match(store.element('#items').innerHTML, /20% OFF/);
  assert.match(store.element('#grid').innerHTML, /<del>/);
  assert.match(store.element('#new-products').innerHTML, /href="#product-1"/);
  assert.match(store.element('#best-sellers').innerHTML, /Granola/);
  assert.equal(store.element('#offer-products').innerHTML, '');
  assert.equal(store.element('#ofertas').hidden, true);
});

test('Tuesday products stay out of the offers page while their saved cart keeps the discount', async () => {
  const store = await storefront({ '1:100': portion(100, 1) }, 5000, '', {
    tuesday_promo: 1, discount_percent: 20,
  }, { offersPage: true });
  assert.equal(store.visible(), false);
  assert.match(store.element('#catalog-status').textContent, /Não há ofertas ativas/);
  assert.doesNotMatch(store.element('.filters').innerHTML, /Grãos/);
  assert.match(store.element('.filters').innerHTML, /Todos/);
  assert.deepEqual(store.cart(), { '1:100': portion(100, 1) });
  assert.equal(store.element('#total').textContent, (4.8).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  assert.match(store.element('#items').innerHTML, /20% OFF/);
});

test('discounted products outside Tuesday remain eligible for home offers and the offers page', async () => {
  const home = await storefront({}, 5000, '', { tuesday_promo: 0, discount_percent: 10 });
  assert.equal(home.element('#ofertas').hidden, false);
  assert.match(home.element('#offer-products').innerHTML, /Granola/);
  const offers = await storefront({}, 5000, '', { tuesday_promo: 0, discount_percent: 10 }, { offersPage: true });
  assert.equal(offers.visible(), true);
  assert.equal(offers.element('#catalog-status').hidden, true);
  assert.match(offers.element('.filters').innerHTML, /Grãos/);
});

test('Tuesday selection keeps the normal category and price outside the promotion day', async () => {
  const store = await storefront({}, 5000, '', { tuesday_promo: 1, discount_percent: 0 });
  store.selectWeight(250);
  store.clickAdd();
  assert.equal(store.element('#total').textContent, (15).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  assert.equal(store.element('#ofertas').hidden, true);
  assert.equal(store.element('#offer-products').innerHTML, '');
  assert.doesNotMatch(store.element('#grid').innerHTML, /20% OFF|<del>/);
  assert.doesNotMatch(store.element('.filters').innerHTML, /Terça/);
  assert.match(store.element('.filters').innerHTML, /Grãos/);
});

test('shipping progress follows discounted subtotal and the selected destination', async () => {
  const store = await storefront({}, 5000);
  store.element('#delivery-area').value = 'maracanau';
  store.selectWeight(833); store.clickAdd();
  assert.match(store.element('#shipping-progress-message').textContent, /Faltam.*0,02/);
  store.changeQuantity('remove', '1:833');
  store.selectWeight(834); store.clickAdd();
  assert.match(store.element('#shipping-progress-message').textContent, /grátis liberada/);
  store.element('#delivery-area').value = 'other';
  store.element('#delivery-area').onchange();
  assert.match(store.element('#shipping-progress-message').textContent, /outras cidades a combinar/);
  assert.equal(store.element('#other-city-label').hidden, false);
  const discounted = await storefront({}, 5000, '', { discount_percent: 20 });
  discounted.element('#delivery-area').value = 'maracanau';
  discounted.selectWeight(1000); discounted.clickAdd();
  assert.match(discounted.element('#shipping-progress-message').textContent, /Faltam.*2,00/);
});

test('ready kits add their exact portions atomically and share product inventory', async () => {
  const store = await storefront({}, 500, '', {}, { kits: [{ id: 1, name: 'Kit Café da Manhã', description: 'Granola em duas porções.', components: [{ id: 1, weight_grams: 100, qty: 2 }] }] });
  store.clickKit(1);
  assert.deepEqual(store.cart(), { '1:100': portion(100, 2) });
  store.clickKit(1); store.clickKit(1);
  assert.deepEqual(store.cart(), { '1:100': portion(100, 4) });
  assert.match(store.element('#ready-kits').innerHTML, /12,00/);
});

test('saved malformed portions are sanitized before kit availability is evaluated', async () => {
  const store = await storefront({ bad: null, '1:100': portion(100, 1) }, 500, '', {}, { kits: [{ id: 1, name: 'Kit', description: '', components: [{ id: 1, weight_grams: 100, qty: 2 }] }] });
  assert.deepEqual(store.cart(), { '1:100': portion(100, 1) });
  store.clickKit(1);
  assert.deepEqual(store.cart(), { '1:100': portion(100, 3) });
});

test('background catalog refresh updates stock and adjusts portions without requiring a failed checkout', async () => {
  const store = await storefront({ '1:100': portion(100, 3) }, 500);
  store.setStock(150);
  await store.refreshCatalog();
  assert.deepEqual(store.cart(), { '1:100': portion(100, 1) });
  assert.doesNotMatch(store.element('#grid').innerHTML, /stock-availability|Estoque disponível/);
  assert.equal(store.add.disabled, true, 'The remaining stock still prevents adding another portion');
  assert.match(store.element('#toast').textContent, /estoque disponível/);
  store.setStock(0);
  await store.refreshCatalog();
  assert.deepEqual(store.cart(), {});
  assert.equal(store.add.disabled, true);
});

test('cart changes in another tab synchronize additions and clearing', async () => {
  const store = await storefront({}, 500);
  store.setSavedCart({ '1:100': portion(100, 2) });
  assert.deepEqual(store.cart(), { '1:100': portion(100, 2) });
  assert.equal(store.element('#cc').textContent, 2);
  store.setSavedCart(null);
  assert.deepEqual(store.cart(), {});
  assert.equal(store.element('#co').hidden, true);
});

test('restored carts respect the same fifty-line limit as new additions', async () => {
  const saved = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`1:${i + 1}`, portion(i + 1, 1)]));
  const store = await storefront(saved, 5000);
  assert.equal(Object.keys(store.cart()).length, 50);
  assert.equal(store.element('#cc').textContent, 50);
});

test('pending checkout blocks duplicate submissions and preserves additions received from another tab', async () => {
  let resolveResponse;
  let requests = 0;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const store = await storefront({ '1:100': portion(100, 2) }, 5000, '', {}, { submit: () => { requests++; return response; } });
  const pending = store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.equal(store.element('#send').disabled, true);
  store.changeQuantity('+');
  store.clickAdd();
  await store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.equal(requests, 1);
  assert.equal(store.cart()['1:100'].qty, 2);
  store.setSavedCart({ '1:100': portion(100, 3) });
  resolveResponse({ ok: true, json: async () => ({ whatsapp_url: 'https://wa.me/5585999999999' }) });
  await pending;
  assert.deepEqual(store.cart(), { '1:100': portion(100, 1) });
  assert.equal(store.element('#send').disabled, false);
});

test('uncertain checkout retries reuse the same request and clear its stored data after success', async () => {
  const session = new Map();
  const requests = [];
  const store = await storefront({ '1:100': portion(100, 1) }, 5000, '', {}, {
    session,
    submit: async (_, config) => {
      requests.push(JSON.parse(config.body));
      if (requests.length === 1) throw new Error('Conexão interrompida');
      return { ok: true, status: 200, json: async () => ({ id: 12, duplicate: true, whatsapp_url: 'https://wa.me/5585999999999' }) };
    },
  });
  await store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.equal(store.cart()['1:100'].qty, 1);
  assert.equal(session.size, 1);
  assert.match(requests[0].request_id, /^[0-9a-f-]{36}$/);
  await store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(store.cart(), {});
  assert.equal(session.size, 0);
});

test('reload and changed prices preserve the original request for an uncertain checkout', async () => {
  const session = new Map();
  let original;
  const first = await storefront({ '1:100': portion(100, 1) }, 5000, '', {}, {
    session, submit: async (_, config) => { original = JSON.parse(config.body); throw new Error('Resposta perdida'); },
  });
  await first.element('#co').onsubmit({ preventDefault() {}, target: {} });
  let replay;
  const restored = await storefront(first.cart(), 5000, '', { price_cents: 2800 }, {
    session, submit: async (_, config) => {
      replay = JSON.parse(config.body);
      return { ok: true, status: 200, json: async () => ({ id: 12, duplicate: true, whatsapp_url: 'https://wa.me/5585999999999' }) };
    },
  });
  await restored.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.deepEqual(replay, original);
  assert.equal(replay.expected_total_cents, 600);
  assert.equal(session.size, 0);
  assert.deepEqual(restored.cart(), {});
});

test('a definitive price conflict starts a new checkout after review', async () => {
  const session = new Map();
  const requests = [];
  const layout = {};
  const store = await storefront({ '1:100': portion(100, 1) }, 5000, '', layout, {
    session, submit: async (_, config) => {
      requests.push(JSON.parse(config.body));
      if (requests.length === 1) {
        layout.price_cents = 2800;
        return { ok: false, status: 409, json: async () => ({ error: 'Confira o novo preço.' }) };
      }
      return { ok: true, status: 200, json: async () => ({ id: 13, whatsapp_url: 'https://wa.me/5585999999999' }) };
    },
  });
  await store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.equal(session.size, 0);
  assert.match(store.element('#msg').textContent, /novo preço/);
  await store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.notEqual(requests[1].request_id, requests[0].request_id);
  assert.equal(requests[1].expected_total_cents, 700);
});

test('uncertain checkout recovers the original payload after stock changes remove the entire cart', async () => {
  const session = new Map();
  let original;
  const first = await storefront({ '1:100': portion(100, 2) }, 5000, '', {}, {
    session, submit: async (_, config) => { original = JSON.parse(config.body); throw new Error('Resposta perdida'); },
  });
  await first.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.equal(first.element('#checkout-recovery').hidden, false);
  let recovered;
  const reloaded = await storefront(first.cart(), 0, '', {}, {
    session, submit: async (_, config) => {
      recovered = JSON.parse(config.body);
      return { ok: true, json: async () => ({ duplicate: true, whatsapp_url: 'https://wa.me/recovered' }) };
    },
  });
  assert.deepEqual(reloaded.cart(), {});
  assert.equal(reloaded.element('#co').hidden, true);
  assert.equal(reloaded.element('#checkout-recovery').hidden, false);
  await reloaded.element('#recover-checkout').onclick();
  assert.deepEqual(recovered, original);
  assert.equal(reloaded.location.href, 'https://wa.me/recovered');
  assert.equal(reloaded.element('#checkout-recovery').hidden, true);
  assert.equal(session.has('puro-checkout-request-v1'), false);
});

test('clearing or editing the cart cannot replace an unresolved checkout request', async () => {
  const requests = [];
  const store = await storefront({ '1:100': portion(100, 2) }, 5000, '', {}, {
    submit: async (_, config) => {
      requests.push(JSON.parse(config.body));
      if (requests.length === 1) throw new Error('Resposta perdida');
      return { ok: true, json: async () => ({ duplicate: true, whatsapp_url: 'https://wa.me/original' }) };
    },
  });
  await store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  store.element('#clearCart').onclick();
  assert.deepEqual(store.cart(), {});
  assert.equal(store.element('#checkout-recovery').hidden, false);
  store.selectWeight(250); store.clickAdd();
  await store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(requests[1].items[0].qty, 2);
  assert.deepEqual(store.cart(), { '1:250': portion(250, 1) }, 'A new portion stays in the cart while the prior send is recovered');
});

test('unit cards show piece prices, add selected quantities and enforce available unit stock', async () => {
  const store = await storefront({}, 0, '', { sale_unit: 'unit', stock_units: 5, price_cents: 1250 });
  assert.match(store.element('#grid').innerHTML, /Por unidade/);
  assert.doesNotMatch(store.element('#grid').innerHTML, /stock-availability|product-category|5 unidades/);
  assert.match(store.element('#grid').innerHTML, /class="reference-price">[^<]*12,50<span class="reference-price-unit"> \/ unidade<\/span>/);
  assert.doesNotMatch(store.element('#grid').innerHTML, /data-custom-weight|data-weight=/);
  store.selectQuantity(3);
  assert.match(store.element('[data-portion-price]').textContent, /37,50/);
  store.clickAdd();
  assert.deepEqual(store.cart(), { '1:unit': { id: 1, sale_unit: 'unit', weight_grams: 0, qty: 3 } });
  assert.match(store.element('#items').innerHTML, /3 unidades no total/);
  assert.doesNotMatch(store.element('#items').innerHTML, /gramas|porção|0 g/);
  store.clickAdd();
  assert.equal(store.cart()['1:unit'].qty, 3);
  store.changeQuantity('+', '1:unit');
  store.changeQuantity('+', '1:unit');
  store.changeQuantity('+', '1:unit');
  assert.equal(store.cart()['1:unit'].qty, 5);
  assert.match(store.element('#total').textContent, /62,50/);
});

test('unit steppers change the selection, prevent negative amounts and respect shared stock', async () => {
  const store = await storefront({}, 0, '', { sale_unit: 'unit', stock_units: 5, price_cents: 1250 });
  store.stepQuantity('-');
  assert.equal(store.element('[data-unit-quantity]').value, 0);
  assert.equal(store.element('[data-unit-step="-"]').disabled, true);
  assert.match(store.element('[data-portion-price]').textContent, /0,00/);
  assert.equal(store.element('[data-product-error]').textContent, '');
  store.stepQuantity('-'); store.clickAdd();
  assert.deepEqual(store.cart(), {});
  store.stepQuantity('+'); store.stepQuantity('+');
  assert.equal(store.element('[data-unit-quantity]').value, 2);
  assert.match(store.element('[data-portion-price]').textContent, /25,00/);
  store.clickAdd();
  assert.equal(store.cart()['1:unit'].qty, 2);
  store.stepQuantity('+'); store.stepQuantity('+');
  assert.equal(store.element('[data-unit-quantity]').value, 3);
  assert.equal(store.element('[data-unit-step="+"]').disabled, true);
  store.clickAdd();
  assert.equal(store.cart()['1:unit'].qty, 5);
  store.stepQuantity('+'); store.clickAdd();
  assert.equal(store.cart()['1:unit'].qty, 5);
});

test('unit steppers recover invalid input, cap at 99 and disable exhausted products', async () => {
  const store = await storefront({}, 0, '', { sale_unit: 'unit', stock_units: 500 });
  store.selectQuantity(NaN); store.stepQuantity('+');
  assert.equal(store.element('[data-unit-quantity]').value, 1);
  store.selectQuantity(98); store.stepQuantity('+'); store.stepQuantity('+');
  assert.equal(store.element('[data-unit-quantity]').value, 99);
  store.clickAdd();
  assert.equal(store.cart()['1:unit'].qty, 99);
  assert.equal(store.element('[data-unit-step="+"]').disabled, true);
  const empty = await storefront({}, 0, '', { sale_unit: 'unit', stock_units: 0 });
  assert.equal(empty.element('[data-unit-step="-"]').disabled, true);
  assert.equal(empty.element('[data-unit-step="+"]').disabled, true);
  assert.equal(empty.element('[data-unit-quantity]').disabled, true);
});

test('unit quantities reject fractions, zero, negatives and counts beyond ninety-nine', async () => {
  const store = await storefront({}, 0, '', { sale_unit: 'unit', stock_units: 500 });
  for (const quantity of [1.5, 0, -1, 100, NaN]) {
    store.selectQuantity(quantity);
    store.clickAdd();
    assert.equal(store.add.disabled, true);
    assert.deepEqual(store.cart(), {});
  }
  store.selectQuantity(99); store.clickAdd();
  store.selectQuantity(1); store.clickAdd();
  assert.equal(store.cart()['1:unit'].qty, 99);
  assert.match(store.element('[data-product-error]').textContent, /99 unidades/);
});

test('unit cart restore, stock refresh, sharing and free shipping use quantities', async () => {
  const store = await storefront({ '1:unit': { id: 1, sale_unit: 'unit', weight_grams: 0, qty: 8 } }, 0, '', { sale_unit: 'unit', stock_units: 5, price_cents: 1250 });
  assert.equal(store.cart()['1:unit'].qty, 5);
  store.element('#delivery-area').value = 'maracanau';
  store.element('#delivery-area').onchange();
  assert.match(store.element('#shipping-progress-message').textContent, /grátis liberada/);
  const message = new URL(store.element('[data-share-product]').href).searchParams.get('text');
  assert.match(message, /12,50.*1 unidade/);
  assert.doesNotMatch(message, /100 g/);
  store.setProduct({ stock_units: 2 });
  await store.refreshCatalog();
  assert.equal(store.cart()['1:unit'].qty, 2);
  store.setProduct({ stock_units: 0 });
  await store.refreshCatalog();
  assert.deepEqual(store.cart(), {});
  assert.equal(store.add.disabled, true);
});

test('changing the selling method discards stale cart lines rather than interpreting grams as units', async () => {
  const store = await storefront({ '1:100': portion(100, 1) }, 5000);
  store.setProduct({ sale_unit: 'unit', stock_units: 5 });
  await store.refreshCatalog();
  assert.deepEqual(store.cart(), {});
  store.clickAdd();
  assert.equal(store.cart()['1:unit'].qty, 1);
  store.setProduct({ sale_unit: 'weight' });
  await store.refreshCatalog();
  assert.deepEqual(store.cart(), {});
});

test('unit kits add quantities atomically and successful checkout removes submitted unit rows', async () => {
  const item = { id: 1, sale_unit: 'unit', weight_grams: 0, qty: 2 };
  const store = await storefront({}, 0, '', { sale_unit: 'unit', stock_units: 5, price_cents: 1250 }, {
    kits: [{ id: 1, name: 'Kit', description: '', components: [item] }],
    submit: () => ({ ok: true, json: async () => ({ whatsapp_url: 'https://wa.me/5585999999999' }) }),
  });
  store.clickKit(1); store.clickKit(1); store.clickKit(1);
  assert.equal(store.cart()['1:unit'].qty, 4);
  assert.match(store.element('#ready-kits').innerHTML, /25,00/);
  await store.element('#co').onsubmit({ preventDefault() {}, target: {} });
  assert.deepEqual(store.cart(), {});
  assert.equal(store.location.href, 'https://wa.me/5585999999999');
});
