const $ = selector => document.querySelector(selector);
const formatBrl = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatWeight = grams => grams >= 1000 ? `${(grams / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kg` : `${grams} g`;
const { portionPrice, isUnit, stockAmount, formatUnits, formatAmount, cartKey } = PuroPricing;
const uiIcon = name => globalThis.PuroIcons?.svg(name) || '';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const normalize = value => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const CART_KEY = 'puro-cart-weight-v1';
const CHECKOUT_REQUEST_KEY = 'puro-checkout-request-v1';
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let pendingCheckout = null;
try {
  const saved = JSON.parse(sessionStorage.getItem(CHECKOUT_REQUEST_KEY) || 'null');
  if (saved && REQUEST_ID_PATTERN.test(saved.payload?.request_id)
      && Array.isArray(saved.payload.items) && saved.payload.items.length > 0 && saved.payload.items.length <= 50
      && Number.isFinite(saved.created_at) && Date.now() - saved.created_at >= 0 && Date.now() - saved.created_at < 86400000) {
    pendingCheckout = saved;
  } else sessionStorage.removeItem(CHECKOUT_REQUEST_KEY);
} catch (_) {}
function newCheckoutRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error('Use um navegador atualizado para enviar seu pedido.');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function checkoutRequest(payload) {
  // Resolve an uncertain previous send before accepting any changed cart or form.
  if (!pendingCheckout) {
    pendingCheckout = { payload: { ...payload, request_id: newCheckoutRequestId() }, created_at: Date.now() };
    try { sessionStorage.setItem(CHECKOUT_REQUEST_KEY, JSON.stringify(pendingCheckout)); } catch (_) {}
  }
  return pendingCheckout.payload;
}
function clearCheckoutRequest() {
  pendingCheckout = null;
  try { sessionStorage.removeItem(CHECKOUT_REQUEST_KEY); } catch (_) {}
}
let products = [];
let cart = {};
let selectedCategory = 'Todos';
let maxWeight = 100000;
let toastTimer;
let promotion = null;
let promotionTimer;
let countdownTimer;
let promotionClockOffset = 0;
let kits = [];
let shippingMinimum = 5000;
let cartTrigger;
let catalogReady = false;
let refreshingCatalog = false;
let submittingOrder = false;
const offersPage = document.body?.dataset?.page === 'offers';
const isOfferProduct = product => product.discount_percent > 0 && !product.tuesday_promo;
const selections = new Map();
function readSavedCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch (_) { return {}; }
}
cart = readSavedCart();
globalThis.addEventListener?.('storage', event => {
  if (event.key !== CART_KEY && event.key !== null) return;
  cart = readSavedCart();
  if (catalogReady) renderCart();
});

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2800);
}
function usedStock(id) {
  return Object.values(cart).filter(item => item.id === id).reduce((sum, item) => sum + (item.sale_unit === 'unit' ? 1 : item.weight_grams) * item.qty, 0);
}
function portionCount(id) {
  return Object.values(cart).filter(item => item.id === id).reduce((sum, item) => sum + item.qty, 0);
}
function selectedWeight(id) {
  return Number(selections.get(id)?.grams ?? 100);
}
function selectedQuantity(id) { return Number(selections.get(id)?.quantity ?? 1); }
function validQuantity(quantity) { return Number.isInteger(quantity) && quantity >= 1 && quantity <= 99; }
function validWeight(grams) {
  return Number.isInteger(grams) && grams >= 1 && grams <= maxWeight;
}
function productShareUrl(product, grams) {
  const weight = validWeight(grams) ? grams : product.price_weight_grams;
  const link = `${location.origin || ''}/?produto=${product.id}#product-${product.id}`;
  const message = `${product.name} na Puro Grão\n${formatBrl(portionPrice(product, weight))} por ${formatAmount(product, isUnit(product) ? 1 : weight)}${product.discount_percent ? ' · 20% OFF hoje' : ''}\n${link}\nConfira o preço e a disponibilidade ao abrir o produto.`;
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

function renderBanner(banner) {
  const element = $('#home-banner');
  if (!element) return;
  element.hidden = !banner?.active;
  updateHighlightsVisibility();
  if (!banner?.active) return;
  $('#home-banner-title').textContent = banner.title;
  $('#home-banner-description').textContent = banner.description;
  $('#home-banner-description').hidden = !banner.description;
  const link = $('#home-banner-link');
  link.hidden = !banner.link_url || !banner.link_label;
  link.textContent = banner.link_label;
  link.href = banner.link_url || '#produtos';
}
function updateHighlightsVisibility() {
  const wrapper = $('#home-highlights');
  if (wrapper) wrapper.hidden = ['#best-sellers-section', '#new-products-section', '#ofertas', '#kits-prontos', '#home-banner'].every(selector => $(selector)?.hidden !== false);
}

function revealSharedProduct() {
  const match = (location.search || '').match(/(?:^|[?&])produto=(\d+)(?:&|$)/) || (location.hash || '').match(/^#product-(\d+)$/);
  if (!match) return;
  const card = $(`#product-${Number(match[1])}`);
  if (!card) { notify('Esse produto está indisponível. Confira as outras opções no catálogo.'); return; }
  card.scrollIntoView({ block: 'start', behavior: 'instant' });
  card.focus({ preventScroll: true });
}
function availableStock(product) {
  return Math.max(0, stockAmount(product) - usedStock(product.id));
}

function cartTotal() {
  return Object.values(cart).reduce((sum, item) => sum + portionPrice(products.find(product => product.id === item.id), item.weight_grams) * item.qty, 0);
}
function updateShipping() {
  const total = cartTotal();
  const area = $('#delivery-area').value || 'pickup';
  const maracanau = area === 'maracanau' || area === 'other' && normalize($('#other-city-label input').value || '').trim() === 'maracanau';
  const missing = Math.max(0, shippingMinimum - total);
  $('#shipping-benefit').hidden = !Object.keys(cart).length;
  $('#shipping-progress-message').textContent = maracanau
    ? missing ? `Faltam ${formatBrl(missing)} para liberar entrega grátis.` : 'Entrega grátis liberada para Maracanaú!'
    : area === 'other' ? 'Frete para outras cidades a combinar com a loja.'
    : missing ? `Mais ${formatBrl(missing)} em produtos liberam entrega grátis em Maracanaú.` : 'Seu pedido libera frete grátis se você escolher entrega em Maracanaú.';
  $('#shipping-progress').setAttribute('aria-valuenow', String(Math.min(total, shippingMinimum) / 100));
  $('#shipping-progress').querySelector('span').style.width = `${Math.min(100, total / shippingMinimum * 100)}%`;
  $('#other-city-label').hidden = area !== 'other';
  $('#other-city-label input').required = area === 'other';
  $('#co [name=address]').required = area !== 'pickup';
  $('.checkout-note').textContent = maracanau && !missing ? 'Entrega grátis em Maracanaú. Pagamento a combinar pelo WhatsApp.' : area === 'pickup' ? 'Retirada na loja. Pagamento a combinar pelo WhatsApp.' : 'Frete e pagamento a combinar pelo WhatsApp.';
  const homeBar = $('#home-shipping-bar');
  if (homeBar) {
    $('#home-shipping-total').textContent = formatBrl(total);
    const portions = Object.values(cart).reduce((sum, item) => sum + item.qty, 0);
    $('#home-shipping-items').textContent = `${portions} ${portions === 1 ? 'item' : 'itens'}`;
    $('#home-shipping-message').textContent = missing ? `Faltam ${formatBrl(missing)} para frete grátis em Maracanaú.` : 'Meta atingida! Frete grátis para entrega em Maracanaú.';
    $('#home-shipping-progress').setAttribute('aria-valuemax', String(shippingMinimum / 100));
    $('#home-shipping-progress').setAttribute('aria-valuenow', String(Math.min(total, shippingMinimum) / 100));
    $('#home-shipping-progress').querySelector('span').style.width = `${Math.min(100, total / shippingMinimum * 100)}%`;
  }
}
$('#delivery-area').onchange = updateShipping;
$('#other-city-label input').oninput = updateShipping;

function updateCountdown() {
  clearTimeout(countdownTimer);
  const elements = document.querySelectorAll('[data-promo-countdown]');
  const remaining = promotion?.active && promotion.ends_at ? Date.parse(promotion.ends_at) - Date.now() - promotionClockOffset : 0;
  elements.forEach(element => {
    element.hidden = !promotion?.active || promotion.name === 'Terça do Granel' || !products.some(isOfferProduct);
    if (element.hidden) { element.textContent = ''; return; }
    const minutes = Math.max(0, Math.ceil(remaining / 60000));
    element.textContent = remaining > 0 ? `Oferta termina em ${String(Math.floor(minutes / 60)).padStart(2, '0')}h ${String(minutes % 60).padStart(2, '0')}min` : 'Oferta encerrada. Atualizando preços…';
  });
  if (remaining > 0) countdownTimer = setTimeout(updateCountdown, 1000);
  else if (promotion?.active && promotion.ends_at) checkPromotion();
}

function kitCanAdd(kit) {
  if (submittingOrder) return false;
  const newKeys = new Set(Object.keys(cart));
  for (const item of kit.components) {
    const product = products.find(product => product.id === item.id);
    if (!product || isUnit(product) !== (item.sale_unit === 'unit') || availableStock(product) < (isUnit(product) ? 1 : item.weight_grams) * item.qty || portionCount(item.id) + item.qty > 99) return false;
    newKeys.add(cartKey(item));
  }
  return newKeys.size <= 50;
}
function renderKits() {
  if (!$('#ready-kits')) return;
  $('#kits-prontos').hidden = kits.length === 0;
  updateHighlightsVisibility();
  $('#ready-kits').innerHTML = kits.map(kit => {
    const total = discount => kit.components.reduce((sum, item) => {
      const product = products.find(product => product.id === item.id);
      return sum + portionPrice(discount ? product : { ...product, discount_percent: 0 }, item.weight_grams) * item.qty;
    }, 0);
    return `<article class="highlight-card kit-card" data-kit="${kit.id}"><div class="kit-illustration" aria-hidden="true">${uiIcon('package')}</div><div class="highlight-info"><small>Uma combinação na sua medida</small><h3>${escapeHtml(kit.name)}</h3><p class="description">${escapeHtml(kit.description)}</p><ul>${kit.components.map(item => `<li>${item.qty}× ${escapeHtml(products.find(product => product.id === item.id).name)} · ${item.sale_unit === 'unit' ? 'unidade' : formatWeight(item.weight_grams)}</li>`).join('')}</ul><p>${total(true) < total(false) ? `<del>${formatBrl(total(false))}</del> ` : ''}${formatBrl(total(true))} <small>/ kit</small></p><button class="btn" type="button" data-add-kit="${kit.id}">Adicionar kit</button><small>Os produtos entram no pedido com as quantidades e pesos acima.</small></div></article>`;
  }).join('');
  updateKitControls();
}
function updateKitControls() {
  for (const kit of kits) {
    const button = $(`[data-add-kit="${kit.id}"]`);
    if (button) { button.disabled = !kitCanAdd(kit); button.textContent = submittingOrder ? 'Enviando pedido…' : button.disabled ? 'Quantidade indisponível' : 'Adicionar kit'; }
  }
}
if ($('#ready-kits')) $('#ready-kits').onclick = event => {
  const button = event.target.closest('[data-add-kit]');
  if (!button || button.disabled) return;
  const kit = kits.find(kit => kit.id === Number(button.dataset.addKit));
  if (!kit || !kitCanAdd(kit)) return;
  const next = { ...cart };
  kit.components.forEach(item => {
    const key = cartKey(item);
    next[key] = { ...item, qty: (next[key]?.qty || 0) + item.qty };
  });
  cart = next;
  renderCart();
  notify(`${kit.name} adicionado ao seu pedido.`);
};

function productDescription(product, expanded) {
  const description = String(product.description || '').trim();
  if (!description) return '';
  return `<details class="product-description"${expanded ? ' open' : ''}><summary data-description-toggle aria-controls="product-description-${product.id}"><span class="description-show">Mostrar descrição</span><span class="description-hide">Ocultar descrição</span></summary><p class="description" id="product-description-${product.id}">${escapeHtml(description)}</p></details>`;
}

// Decorative, code-native pantry illustrations; colors come from the product palette.
function productIllustration(product) {
  const nuts = normalize(product.category).includes('castanh');
  const tea = normalize(product.category).includes('cha');
  let seeds = '';
  for (let i = 0; i < 46; i++) {
    const angle = i * 2.4;
    const radius = 9 + Math.sqrt(i) * 10;
    const x = 120 + Math.cos(angle) * radius;
    const y = 75 + Math.sin(angle) * radius * .45;
    const color = `var(--illustration-${tea ? 'tea' : nuts ? 'nut' : 'grain'}-${i % 3 + 1})`;
    seeds += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${nuts ? 10 : tea ? 8 : 5}" ry="${nuts ? 6 : 3}" fill="${color}" transform="rotate(${i * 37} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }
  return `<svg viewBox="0 0 240 170" aria-hidden="true"><ellipse cx="120" cy="142" rx="72" ry="8" fill="currentColor" opacity=".07"/><path d="M38 82Q44 142 120 145Q196 142 202 82Z" fill="${escapeHtml(product.color)}"/><path d="M51 93Q62 129 120 134" fill="none" stroke="var(--illustration-rim)" stroke-opacity=".22" stroke-width="3"/><ellipse cx="120" cy="81" rx="82" ry="36" fill="var(--illustration-rim)"/><ellipse cx="120" cy="79" rx="74" ry="29" fill="var(--illustration-base)"/>${seeds}<ellipse cx="120" cy="81" rx="81" ry="35" fill="none" stroke="var(--illustration-rim)" stroke-width="5"/></svg>`;
}

function updateProductControls() {
  for (const product of products) {
    const card = $(`[data-product="${product.id}"]`);
    if (!card) continue;
    const unit = isUnit(product);
    const grams = selectedWeight(product.id);
    const amount = unit ? selectedQuantity(product.id) : grams;
    const valid = unit ? validQuantity(amount) : validWeight(grams);
    const unselected = unit && amount === 0;
    const remaining = availableStock(product);
    card.querySelector('[data-portion-price]').textContent = valid ? formatBrl(portionPrice(product, grams) * (unit ? amount : 1)) : unselected ? formatBrl(0) : '—';
    card.querySelector('[data-portion-label]').textContent = valid ? `${unit ? 'para' : 'por'} ${formatAmount(product, amount)}` : unit ? 'Escolha a quantidade' : 'Informe o peso';
    card.querySelector('[data-share-product]').href = productShareUrl(product, grams);
    const add = card.querySelector('[data-add]');
    add.disabled = submittingOrder || !valid || amount > remaining || portionCount(product.id) + (unit ? amount : 1) > 99;
    add.innerHTML = stockAmount(product) === 0 ? 'Esgotado' : 'Adicionar <span aria-hidden="true">+</span>';
    const error = card.querySelector('[data-product-error]');
    error.textContent = unselected ? '' : !valid ? unit ? 'Informe uma quantidade inteira de 1 a 99.' : 'Informe um peso inteiro de 1 a 100.000 g.' :
      amount > remaining && stockAmount(product) > 0 ? `Restam ${formatAmount(product, remaining)} para adicionar.` :
      portionCount(product.id) + (unit ? amount : 1) > 99 ? `Limite de 99 ${unit ? 'unidades' : 'porções'} por produto.` : '';
    if (unit) {
      const limit = Math.max(0, Math.min(remaining, 99 - portionCount(product.id)));
      const input = card.querySelector('[data-unit-quantity]');
      input.disabled = submittingOrder || stockAmount(product) === 0;
      input.max = limit;
      card.querySelector('[data-unit-step="-"]').disabled = submittingOrder || stockAmount(product) === 0 || !Number.isInteger(amount) || amount <= 0;
      card.querySelector('[data-unit-step="+"]').disabled = submittingOrder || limit === 0 || Number.isInteger(amount) && amount >= limit;
      continue;
    }
    card.querySelectorAll('[data-weight]').forEach(button => {
      button.disabled = submittingOrder || button.dataset.weight !== 'custom' && Number(button.dataset.weight) > remaining;
    });
    card.querySelector('[data-custom-weight]').disabled = submittingOrder;
  }
}

function renderCart() {
  const focusedKey = document.activeElement?.dataset?.key;
  const focusedAction = document.activeElement?.dataset?.action;
  const used = new Map();
  const counts = new Map();
  let adjusted = false;
  let validRows = 0;
  for (const [key, item] of Object.entries(cart)) {
    const product = products.find(product => product.id === item?.id);
    if (!product || isUnit(product) !== (item.sale_unit === 'unit') || (isUnit(product) ? item.weight_grams !== 0 : !validWeight(item.weight_grams)) || !Number.isInteger(item.qty) || item.qty < 1 || key !== cartKey(item) || validRows >= 50) {
      delete cart[key]; adjusted = true; continue;
    }
    const amount = isUnit(product) ? 1 : item.weight_grams;
    const remaining = stockAmount(product) - (used.get(item.id) || 0);
    const quantity = Math.min(item.qty, 99 - (counts.get(item.id) || 0), Math.floor(remaining / amount));
    if (quantity < 1) { delete cart[key]; adjusted = true; continue; }
    if (quantity !== item.qty) adjusted = true;
    item.qty = quantity;
    validRows++;
    used.set(item.id, (used.get(item.id) || 0) + quantity * amount);
    counts.set(item.id, (counts.get(item.id) || 0) + quantity);
  }
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (_) {}
  const rows = Object.entries(cart).map(([key, item]) => ({ key, item, product: products.find(product => product.id === item.id) }));
  $('#cart-actions').hidden = rows.length === 0;
  $('#clearCart').disabled = submittingOrder;
  $('#cc').textContent = rows.reduce((sum, row) => sum + row.item.qty, 0);
  $('#items').innerHTML = rows.length ? rows.map(({ key, item, product }) => `
    <div class="it"><div><b>${escapeHtml(product.name)}</b><small>${isUnit(product) ? `${formatUnits(item.qty)} no total` : `${formatWeight(item.weight_grams)} por porção · ${formatWeight(item.weight_grams * item.qty)} no total`}</small></div>
      <b>${formatBrl(portionPrice(product, item.weight_grams) * item.qty)}${product.discount_percent ? '<small class="cart-promotion">Terça · 20% OFF</small>' : ''}</b>
      <div class="qty"><button data-action="-" data-key="${key}" aria-label="Diminuir quantidade de ${escapeHtml(product.name)}">−</button><span>${isUnit(product) ? formatUnits(item.qty) : `${item.qty} ${item.qty === 1 ? 'porção' : 'porções'}`}</span><button data-action="+" data-key="${key}" aria-label="Aumentar quantidade de ${escapeHtml(product.name)}" ${availableStock(product) < (isUnit(product) ? 1 : item.weight_grams) || portionCount(item.id) >= 99 ? 'disabled' : ''}>+</button><button class="rm" data-action="remove" data-key="${key}">Remover</button></div>
    </div>`).join('') : '<div class="empty"><strong>Seu pedido começa aqui.</strong>Escolha seus produtos e a quantidade que combina com você.</div>';
  $('#checkout-recovery').hidden = !pendingCheckout || submittingOrder;
  $('#recover-checkout').disabled = submittingOrder;
  $('#co').hidden = !rows.length || Boolean(pendingCheckout) && !submittingOrder;
  $('#total').textContent = formatBrl(rows.reduce((sum, row) => sum + portionPrice(row.product, row.item.weight_grams) * row.item.qty, 0));
  updateProductControls();
  updateShipping();
  updateKitControls();
  if (submittingOrder) $('#items').querySelectorAll('button').forEach(button => { button.disabled = true; });
  if (focusedKey && focusedAction) {
    const replacement = $(`[data-key="${focusedKey}"][data-action="${focusedAction}"]:not(:disabled)`) || $('#items button:not(:disabled)') || $('#closeCart');
    replacement.focus({ preventScroll: true });
  }
  return adjusted;
}

function applyFilters() {
  const query = normalize($('#search').value || '');
  let visible = 0;
  document.querySelectorAll('.card').forEach(card => {
    const product = products.find(product => product.id === Number(card.dataset.product));
    card.hidden = (offersPage && !isOfferProduct(product)) || (selectedCategory !== 'Todos' && product.category !== selectedCategory) || !ProductSearch.matches(product, query);
    if (!card.hidden) visible++;
  });
  $('#catalog-status').hidden = visible > 0;
  $('#catalog-status').textContent = offersPage && !products.some(isOfferProduct) ? 'Não há ofertas ativas hoje. Confira os produtos no catálogo da loja.' : products.length ? 'Não encontramos produtos para essa busca.' : 'Nossa seleção estará disponível em breve.';
}

function priceLabel(product) {
  const current = formatBrl(portionPrice(product, product.price_weight_grams));
  return product.discount_percent ? `<del>${formatBrl(product.price_cents)}</del> <strong>${current}</strong>` : current;
}

function productPhoto(product) {
  return `<button type="button" class="product-photo-trigger" data-open-product-image aria-label="Ampliar foto de ${escapeHtml(product.name)}" aria-haspopup="dialog" aria-controls="product-image-dialog"><img class="product-photo" src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" style="object-position:${Number.isInteger(product.image_position_x) ? product.image_position_x : 50}% ${Number.isInteger(product.image_position_y) ? product.image_position_y : 50}%;object-fit:${product.image_fit === 'contain' ? 'contain' : 'cover'}" loading="lazy"></button>`;
}

function renderHighlights() {
  if (offersPage) return;
  const offers = products.filter(isOfferProduct);
  const shelves = [
    ['best-sellers', products.filter(product => product.best_seller_rank).sort((a, b) => a.best_seller_rank - b.best_seller_rank), 'best-sellers-section'],
    ['new-products', products.filter(product => product.is_new).sort((a, b) => b.id - a.id).slice(0, 4), 'new-products-section'],
    ['offer-products', offers, 'ofertas'],
  ];
  shelves.forEach(([id, items, section]) => {
    $(`#${section}`).hidden = items.length === 0;
    $(`#${id}`).innerHTML = items.map(product => `
      <article class="highlight-card" data-choose-product="${product.id}">
        <div class="highlight-art">${product.image_url ? productPhoto(product) : `<a class="highlight-art-link" href="#product-${product.id}" aria-label="Ver ${escapeHtml(product.name)}">${productIllustration(product)}</a>`}<span class="highlight-badge ${product.discount_percent ? 'is-offer' : 'is-new'}">${product.discount_percent ? '20% OFF hoje' : id === 'best-sellers' ? 'Mais vendido' : 'Novidade'}</span></div>
        <a class="highlight-info" href="#product-${product.id}" aria-label="Escolher ${isUnit(product) ? 'quantidade' : 'peso'} de ${escapeHtml(product.name)}"><small>${escapeHtml(product.category)}</small><h3>${escapeHtml(product.name)}</h3><p>${priceLabel(product)} <small>/ ${isUnit(product) ? 'unidade' : formatWeight(product.price_weight_grams)}</small></p><span class="highlight-action">${stockAmount(product) === 0 ? 'Esgotado · ver produto' : isUnit(product) ? 'Escolher quantidade' : 'Escolher peso'} ↗</span></a>
      </article>`).join('');
  });
  updateHighlightsVisibility();
}

async function fetchCatalog() {
  const response = await fetch('/api/products', { cache: 'no-store' });
  if (!response.ok) throw new Error('Não foi possível carregar os produtos. Tente novamente.');
  return response.json();
}

function schedulePromotionCheck() {
  clearTimeout(promotionTimer);
  if (promotion) promotionTimer = setTimeout(checkPromotion, 60000);
}

async function checkPromotion() {
  if (refreshingCatalog || submittingOrder || document.visibilityState === 'hidden') return;
  refreshingCatalog = true;
  try {
    const data = await fetchCatalog();
    renderBanner(data.banner);
    const changed = data.promotion?.active !== promotion?.active || JSON.stringify(data.products) !== JSON.stringify(products) || JSON.stringify(data.kits || []) !== JSON.stringify(kits) || (data.shipping?.free_shipping_min_cents || 5000) !== shippingMinimum;
    if (changed) {
      const previousTotal = cartTotal();
      const adjusted = await loadCatalog(data);
      if (adjusted) notify('Atualizamos seu pedido conforme o estoque disponível. Confira as quantidades.');
      else if (cartTotal() !== previousTotal) notify('Atualizamos os preços do seu pedido. Confira o total antes de enviar.');
    } else {
      promotion = data.promotion || null;
      promotionClockOffset = promotion?.server_now ? Date.parse(promotion.server_now) - Date.now() : 0;
      updateCountdown();
    }
  } catch (_) {
    // Checkout validates current prices even if a background refresh fails.
  } finally {
    refreshingCatalog = false;
    schedulePromotionCheck();
  }
}

async function loadCatalog(data) {
  data = data || await fetchCatalog();
  const active = document.activeElement;
  const activeCard = active?.closest?.('[data-product]');
  const focusSelector = activeCard && (active.matches('[data-unit-quantity]') ? '[data-unit-quantity]' : active.dataset.unitStep ? `[data-unit-step="${active.dataset.unitStep}"]` : active.matches('[data-custom-weight]') ? '[data-custom-weight]' : active.dataset.weight ? `[data-weight="${active.dataset.weight}"]` : active.matches('[data-share-product]') ? '[data-share-product]' : active.matches('[data-add]') ? '[data-add]' : active.matches('[data-description-toggle]') ? '[data-description-toggle]' : null);
  const expandedDescriptions = new Set([...document.querySelectorAll('#grid .product-description[open]')].map(details => details.closest('[data-product]').dataset.product));
  renderBanner(data.banner);
  products = data.products;
  promotion = data.promotion || null;
  kits = data.kits || [];
  shippingMinimum = data.shipping?.free_shipping_min_cents || 5000;
  promotionClockOffset = promotion?.server_now ? Date.parse(promotion.server_now) - Date.now() : 0;
  maxWeight = data.max_weight_grams || 100000;
  $('#wa').href = `https://wa.me/${data.whatsapp}`;
  const categories = ['Todos', ...[...new Set(products.filter(product => !offersPage || isOfferProduct(product)).map(product => product.category))].sort()];
  if (!categories.includes(selectedCategory)) selectedCategory = 'Todos';
  $('.filters').innerHTML = categories.map(category => `<button data-category="${escapeHtml(category)}" aria-pressed="${category === selectedCategory}">${escapeHtml(category)}</button>`).join('');
  $('#grid').innerHTML = products.map(product => {
    if (!selections.has(product.id)) selections.set(product.id, { grams: 100, custom: false });
    const selection = selections.get(product.id);
    const unit = isUnit(product);
    const stock = stockAmount(product);
    return `<article class="card" id="product-${product.id}" tabindex="-1" data-product="${product.id}" data-sold-out="${stock === 0}">
      <div class="product-art ${product.image_url ? 'has-photo' : ''}">${product.image_url ? productPhoto(product) : productIllustration(product)}${stock === 0 ? '<span class="stock-tag sold-out">Esgotado</span>' : unit ? '<span class="stock-tag">Por unidade</span>' : ''}</div>
      <div class="info"><small class="product-category">${escapeHtml(product.category)}</small><h3>${escapeHtml(product.name)}</h3><div class="product-promotion-tags">${product.discount_percent ? '<span class="offer-badge">Terça · 20% OFF</span>' : ''}${product.is_new ? '<span>Novidade</span>' : ''}</div>${productDescription(product, expandedDescriptions.has(String(product.id)))}<p class="stock-availability ${stock === 0 ? 'out-of-stock' : ''}">${stock > 0 ? `Estoque disponível: <strong>${formatAmount(product, stock)}</strong>` : unit ? 'Esgotado · 0 unidades disponíveis' : 'Esgotado · 0 g disponíveis'}</p><p class="reference-price">${priceLabel(product)} / ${unit ? 'unidade' : formatWeight(product.price_weight_grams)}</p>
        ${unit ? `<div class="unit-quantity"><label for="unit-quantity-${product.id}">Quantidade <small>unidades</small></label><div class="unit-stepper" role="group" aria-label="Escolher quantidade de ${escapeHtml(product.name)}"><button type="button" data-unit-step="-" aria-label="Diminuir quantidade de ${escapeHtml(product.name)}">−</button><input id="unit-quantity-${product.id}" data-unit-quantity type="number" min="0" max="99" step="1" inputmode="numeric" value="${escapeHtml(selection.quantity ?? 1)}" aria-label="Quantidade de ${escapeHtml(product.name)} em unidades"><button type="button" data-unit-step="+" aria-label="Aumentar quantidade de ${escapeHtml(product.name)}">+</button></div></div>` : `<span class="weight-label" id="weight-label-${product.id}">Quanto você quer levar?</span><div class="weights" role="group" aria-labelledby="weight-label-${product.id}">${[100,250,500,1000].map(grams => `<button data-weight="${grams}" aria-pressed="${!selection.custom && selection.grams === grams}">${formatWeight(grams)}</button>`).join('')}<button class="custom-option" data-weight="custom" aria-pressed="${selection.custom}">Peso personalizado</button></div>
        <label class="custom-weight" ${selection.custom ? '' : 'hidden'}>Gramas<input data-custom-weight type="number" min="1" max="${maxWeight}" step="1" inputmode="numeric" value="${escapeHtml(selection.grams)}" aria-label="Peso personalizado de ${escapeHtml(product.name)} em gramas"><span>g</span></label>`}
        <div class="portion-footer"><div><span class="price" data-portion-price></span><small data-portion-label></small></div><button class="btn" data-add="${product.id}">Adicionar <span aria-hidden="true">+</span></button></div><p class="product-error" data-product-error role="status"></p>
        <a class="product-share" data-share-product target="_blank" rel="noopener noreferrer" aria-label="Compartilhar ${escapeHtml(product.name)} pelo WhatsApp"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.3A8 8 0 1 1 20 11.5Z"/><path d="M8.5 7.5c-.5 4 2 6.5 6 7l1-2-2-1-1 1c-1-.5-2-1.5-2.5-2.5l1-1-1-2Z"/></svg>Compartilhar</a>
      </div></article>`;
  }).join('');
  renderHighlights();
  const adjusted = renderCart();
  renderKits();
  applyFilters();
  catalogReady = true;
  if (focusSelector) {
    const card = $(`[data-product="${activeCard.dataset.product}"]`);
    const control = card?.querySelector(focusSelector);
    if (control && !card.hidden && !control.disabled) control.focus({ preventScroll: true });
  }
  schedulePromotionCheck();
  updateCountdown();
  return adjusted;
}

if ($('#home-highlights')) $('#home-highlights').onclick = event => {
  if (event.target.closest('[data-open-product-image]')) return;
  const link = event.target.closest('[data-choose-product]');
  if (!link) return;
  selectedCategory = 'Todos';
  $('#search').value = '';
  $('.filters').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', button.dataset.category === 'Todos'));
  applyFilters();
  $(`#product-${link.dataset.chooseProduct}`).focus({ preventScroll: true });
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && promotion) checkPromotion();
});

$('.filters').onclick = event => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  selectedCategory = button.dataset.category;
  $('.filters').querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', item === button));
  applyFilters();
};
$('#search').oninput = applyFilters;
$('#grid').onclick = event => {
  if (submittingOrder) return;
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const card = button.closest('[data-product]');
  if (!card) return;
  const id = Number(card.dataset.product);
  const product = products.find(product => product.id === id);
  if (button.dataset.unitStep && isUnit(product)) {
    const amount = selectedQuantity(id);
    const current = Number.isInteger(amount) && amount >= 0 ? amount : 0;
    const limit = Math.max(0, Math.min(availableStock(product), 99 - portionCount(id)));
    const quantity = Math.max(0, Math.min(limit, current + (button.dataset.unitStep === '+' ? 1 : -1)));
    selections.set(id, { ...selections.get(id), quantity });
    card.querySelector('[data-unit-quantity]').value = quantity;
    updateProductControls();
  } else if (button.dataset.weight) {
    const custom = button.dataset.weight === 'custom';
    const grams = custom ? Number(card.querySelector('[data-custom-weight]').value) : Number(button.dataset.weight);
    selections.set(id, { grams, custom });
    card.querySelector('.custom-weight').hidden = !custom;
    card.querySelectorAll('[data-weight]').forEach(item => item.setAttribute('aria-pressed', item === button));
    updateProductControls();
    if (custom) card.querySelector('[data-custom-weight]').focus();
  } else if (button.dataset.add) {
    const unit = isUnit(product);
    const grams = selectedWeight(id);
    const quantity = unit ? selectedQuantity(id) : 1;
    if (!(unit ? validQuantity(quantity) : validWeight(grams)) || (unit ? quantity : grams) > availableStock(product) || portionCount(id) + quantity > 99) return;
    const item = unit ? { id, sale_unit: 'unit', weight_grams: 0 } : { id, weight_grams: grams };
    const key = cartKey(item);
    if (!cart[key] && Object.keys(cart).length >= 50) { notify('Seu pedido pode ter até 50 porções diferentes.'); return; }
    cart[key] = { ...item, qty: (cart[key]?.qty || 0) + quantity };
    renderCart();
    $('#msg').textContent = '';
    notify(`${formatAmount(product, unit ? quantity : grams)} de ${product.name} no seu pedido.`);
  }
};
$('#grid').oninput = event => {
  if (submittingOrder) return;
  if (event.target.matches('[data-unit-quantity]')) {
    const id = Number(event.target.closest('[data-product]').dataset.product);
    if (isUnit(products.find(product => product.id === id))) {
      selections.set(id, { ...selections.get(id), quantity: Number(event.target.value) });
      updateProductControls();
      return;
    }
  }
  if (!event.target.matches('[data-custom-weight]')) return;
  const id = Number(event.target.closest('[data-product]').dataset.product);
  selections.set(id, { grams: Number(event.target.value), custom: true });
  updateProductControls();
};
$('#items').onclick = event => {
  if (submittingOrder) return;
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const item = cart[button.dataset.key];
  if (!item) return;
  const product = products.find(product => product.id === item.id);
  if (button.dataset.action === '+' && availableStock(product) >= (isUnit(product) ? 1 : item.weight_grams) && portionCount(item.id) < 99) item.qty++;
  if (button.dataset.action === '-') item.qty--;
  if (button.dataset.action === 'remove' || item.qty < 1) delete cart[button.dataset.key];
  renderCart();
};
$('#clearCart').onclick = () => {
  if (submittingOrder || !Object.keys(cart).length) return;
  cart = {};
  renderCart();
  $('#msg').textContent = '';
  $('#closeCart').focus({ preventScroll: true });
  notify(pendingCheckout ? 'Carrinho esvaziado. Verifique o resultado do pedido anterior.' : 'Carrinho esvaziado.');
};

function setCartOpen(open, trigger = $('#cartBtn')) {
  if (open) cartTrigger = trigger;
  const drawer = $('#drawer');
  drawer.classList.toggle('open', open);
  drawer.inert = !open;
  drawer.setAttribute('aria-hidden', String(!open));
  $('#cartBtn').setAttribute('aria-expanded', String(open));
  if ($('#home-shipping-view')) $('#home-shipping-view').setAttribute('aria-expanded', String(open));
  $('#ov').hidden = !open;
  document.body.classList.toggle('cart-open', open);
  document.querySelectorAll('header, main, footer, .top, .skip-link, #home-shipping-bar').forEach(element => { element.inert = open; });
  if (open) $('#closeCart').focus(); else (cartTrigger || $('#cartBtn')).focus();
}
$('#cartBtn').onclick = () => setCartOpen(true);
if ($('#home-shipping-view')) $('#home-shipping-view').onclick = () => setCartOpen(true, $('#home-shipping-view'));
$('#closeCart').onclick = $('#ov').onclick = () => setCartOpen(false);
document.addEventListener('keydown', event => {
  if (!$('#drawer').classList.contains('open')) return;
  if (event.key === 'Escape') setCartOpen(false);
  if (event.key === 'Tab') {
    const controls = [...$('#drawer').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')].filter(element => element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (!first) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
async function submitCheckout(payload) {
  if (submittingOrder) return;
  $('#msg').textContent = '';
  const submittedItems = payload.items;
  function setBusy(busy) {
    submittingOrder = busy;
    $('#send').disabled = busy;
    $('#co').setAttribute('aria-busy', String(busy));
    $('#co').querySelectorAll('input, select, textarea').forEach(control => { control.disabled = busy; });
    renderCart();
  }
  setBusy(true);
  try {
    const response = await fetch('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 429) clearCheckoutRequest();
      if (response.status === 409) {
        try {
          const adjusted = await loadCatalog();
          if (adjusted) notify('Atualizamos seu pedido conforme o estoque disponível. Confira as quantidades.');
        } catch (_) {}
      }
      throw new Error(data.error || 'Não foi possível enviar o pedido.');
    }
    for (const item of submittedItems) {
      const key = cartKey(item);
      if (!cart[key]) continue;
      cart[key].qty -= item.qty;
      if (cart[key].qty <= 0) delete cart[key];
    }
    clearCheckoutRequest();
    renderCart();
    location.href = data.whatsapp_url;
  } catch (error) {
    $('#msg').textContent = error.message || 'Erro ao enviar. Tente novamente.';
  } finally { setBusy(false); schedulePromotionCheck(); }
}
$('#recover-checkout').onclick = () => pendingCheckout && submitCheckout(pendingCheckout.payload);
$('#co').onsubmit = async event => {
  event.preventDefault();
  if (submittingOrder) return;
  try {
    const form = new FormData(event.target);
    const payload = checkoutRequest({ customer: form.get('customer'), phone: form.get('phone'), address: form.get('address'), notes: form.get('notes'), items: Object.values(cart).map(item => ({ ...item })), expected_total_cents: cartTotal(), delivery_method: form.get('delivery_area') === 'maracanau' || form.get('delivery_area') === 'other' ? 'delivery' : 'pickup', delivery_city: form.get('delivery_area') === 'maracanau' ? 'Maracanaú' : form.get('delivery_area') === 'other' ? form.get('delivery_city') : '' });
    await submitCheckout(payload);
  } catch (error) { $('#msg').textContent = error.message || 'Não foi possível enviar o pedido.'; }
};
loadCatalog().then(revealSharedProduct).catch(error => {
  $('#catalog-status').hidden = false;
  $('#catalog-status').textContent = error.message;
});
