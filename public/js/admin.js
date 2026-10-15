const $ = selector => document.querySelector(selector);
const { portionPrice, MAX_WEIGHT_GRAMS, isUnit, stockAmount, formatAmount, formatUnits } = PuroPricing;
const adminIcon = name => globalThis.PuroIcons?.svg(name) || '';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[character]));
const formatBrl = value => Number(value).toLocaleString('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});
const formatWeight = grams => grams >= 1000 ? `${(grams / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kg` : `${grams} g`;
const parsePrice = value => {
  const text = value.trim();
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  return /^\d+(?:\.\d{1,2})?$/.test(normalized) ? Number(normalized) : NaN;
};
const showError = error => {
  if (!ignoreAdminError(error)) $('#aerr').textContent = error.message || 'Não foi possível carregar o painel.';
};
const showAdminAlert = error => { if (!ignoreAdminError(error)) alert(error.message); };
const whatsappUrl = phone => {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits.length <= 11 ? '55' : ''}${digits}`;
};

let token = '';
try { token = sessionStorage.getItem('t') || ''; } catch (_) {}
let adminSessionEpoch = 0;
let loginAttempt = 0;
const activeImageReaders = new Set();
const captureAdminSession = () => ({ token, epoch: adminSessionEpoch });
const adminSessionIsCurrent = session => Boolean(token) && session.token === token && session.epoch === adminSessionEpoch;
const staleAdminSession = () => Object.assign(new Error('Sessão encerrada.'), { code: 'ADMIN_SESSION_STALE', silent: true });
const assertAdminSession = session => { if (!adminSessionIsCurrent(session)) throw staleAdminSession(); };
const ignoreAdminError = error => !token || error?.silent || error?.code === 'ADMIN_SESSION_STALE' ||
  Boolean(error?.adminSession && !adminSessionIsCurrent(error.adminSession));
let products = [];
let productOrderBusy = false;
let selectedImageFile = null;
let imageChanged = false;
let currentImageUrl = '';
let currentImageLayout = {};
let previewObjectUrl = '';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const LOW_STOCK_GRAMS = 3000;
let saleMode = 'weight';
let stockDrafts = { weight: 0, unit: 0 };
let costDrafts = { weight: '', unit: '' };
function updateSaleFields() {
  const unit = $('#psale-unit').value === 'unit';
  $('#pweight-label').hidden = unit;
  $('#pweight').disabled = unit;
  $('#pweight').required = !unit;
  $('#pprice-label').textContent = unit ? 'Preço por unidade (R$)' : 'Preço de referência (R$)';
  $('#pstock-label').textContent = unit ? 'Estoque disponível (unidades)' : 'Estoque disponível (g)';
  $('#pcost-label').textContent = unit ? 'Custo por unidade (R$)' : 'Custo por kg (R$)';
  $('#ppromo').disabled = unit;
  $('#psale-help').textContent = unit
    ? 'O cliente escolhe unidades inteiras. A Terça do Granel se aplica aos produtos vendidos por peso.'
    : 'O cliente escolhe o peso e o preço é calculado proporcionalmente.';
  if (typeof updateCostPreview === 'function') updateCostPreview();
}
$('#psale-unit').onchange = () => {
  stockDrafts[saleMode] = $('#pstock').value;
  costDrafts[saleMode] = $('#pcost').value;
  saleMode = $('#psale-unit').value;
  $('#pstock').value = stockDrafts[saleMode];
  $('#pcost').value = costDrafts[saleMode];
  updateSaleFields();
};
updateSaleFields();

function updateImageLayout() {
  $('#pimage-preview').style.objectPosition = `${$('#pimage-x').value}% ${$('#pimage-y').value}%`;
  $('#pimage-preview').style.objectFit = $('#pimage-fit').value;
}
function resetImageLayout(product = {}) {
  $('#pimage-x').value = product.image_position_x ?? 50;
  $('#pimage-y').value = product.image_position_y ?? 50;
  $('#pimage-fit').value = product.image_fit || 'cover';
  updateImageLayout();
}
$('#pimage-x').oninput = $('#pimage-y').oninput = $('#pimage-fit').onchange = updateImageLayout;
$('#pimage-center').onclick = () => {
  $('#pimage-x').value = $('#pimage-y').value = 50;
  updateImageLayout();
};

function displayImagePreview(url) {
  if (previewObjectUrl && previewObjectUrl !== url) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = '';
  }
  $('#pimage-box').hidden = !url;
  const session = captureAdminSession();
  $('#pimage-preview').onerror = () => {
    if (!adminSessionIsCurrent(session) || !url || $('#pimage-preview').getAttribute('src') !== url) return;
    if (selectedImageFile) resetImage(currentImageUrl, currentImageLayout);
    $('#pimage-error').textContent = 'Não foi possível abrir essa imagem. Selecione outro arquivo.';
  };
  if (url) $('#pimage-preview').src = url;
  else $('#pimage-preview').removeAttribute('src');
}
function resetImage(url = '', product = {}) {
  selectedImageFile = null;
  imageChanged = false;
  currentImageUrl = url;
  currentImageLayout = { image_position_x: product.image_position_x ?? 50, image_position_y: product.image_position_y ?? 50, image_fit: product.image_fit || 'cover' };
  $('#pimage').value = '';
  $('#pimage-error').textContent = '';
  resetImageLayout(product);
  displayImagePreview(url);
}
$('#pimage').onchange = () => {
  const file = $('#pimage').files[0];
  $('#pimage-error').textContent = '';
  if (!file) { resetImage(currentImageUrl, currentImageLayout); return; }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > MAX_IMAGE_BYTES) {
    resetImage(currentImageUrl, currentImageLayout);
    $('#pimage-error').textContent = 'Selecione uma imagem PNG, JPEG ou WebP de até 5 MB.';
    return;
  }
  selectedImageFile = file;
  imageChanged = true;
  resetImageLayout();
  const url = URL.createObjectURL(file);
  displayImagePreview(url);
  previewObjectUrl = url;
};
$('#pimage-remove').onclick = () => {
  selectedImageFile = null;
  imageChanged = true;
  $('#pimage').value = '';
  $('#pimage-error').textContent = '';
  resetImageLayout();
  displayImagePreview('');
};
const readImage = file => new Promise((resolve, reject) => {
  const session = captureAdminSession();
  try { assertAdminSession(session); } catch (error) { reject(error); return; }
  const reader = new FileReader();
  activeImageReaders.add(reader);
  const finish = callback => { activeImageReaders.delete(reader); callback(); };
  reader.onload = () => finish(() => {
    if (!adminSessionIsCurrent(session)) reject(staleAdminSession());
    else resolve(reader.result);
  });
  reader.onerror = () => finish(() => reject(adminSessionIsCurrent(session)
    ? Object.assign(new Error('Não foi possível ler a imagem. Selecione o arquivo novamente.'), { adminSession: session }) : staleAdminSession()));
  reader.onabort = () => finish(() => reject(staleAdminSession()));
  try { reader.readAsDataURL(file); }
  catch (error) { finish(() => reject(Object.assign(error, { adminSession: session }))); }
});

function clearPrivateAdminState() {
  products = [];
  productOrderBusy = false;
  setProductOrderFeedback('');
  $('#product-list-table').removeAttribute('aria-busy');
  for (const reader of activeImageReaders) {
    try { reader.abort(); } catch (_) {}
  }
  activeImageReaders.clear();
  document.querySelectorAll('#app input, #app select, #app textarea, #app button, #app fieldset').forEach(control => { control.disabled = false; });
  document.querySelectorAll('#app form').forEach(form => form.reset());
  $('#pw').value = '';
  $('#login button').disabled = false;
  $('#aerr').textContent = '';
  productFilterIds.forEach(id => { $(`#product-filter-${id}`).value = ''; });
  refreshProductFilterCategories();
  resetForm();
  renderProductList();
  renderLowStock();
  $('#olist').innerHTML = '';
  if (typeof clearDashboardSession === 'function') clearDashboardSession();
  if (typeof clearBannerSession === 'function') clearBannerSession();
  if (typeof clearInventorySession === 'function') clearInventorySession();
  if (typeof clearKitsSession === 'function') clearKitsSession();
  if (typeof clearSalesSession === 'function') clearSalesSession();
  if (typeof clearSalesHistorySession === 'function') clearSalesHistorySession();
}

function showApp() {
  $('#login').hidden = Boolean(token);
  $('#app').hidden = !token;
  if (token) {
    loadProducts().catch(showError);
    loadOrders().catch(showError);
    loadBanner().catch(showError);
    if (!$('#ps').hidden && typeof loadSales === 'function') loadSales().catch(showError);
    if (!$('#sh').hidden && typeof loadSalesHistory === 'function') loadSalesHistory().catch(showError);
  }
}

function logout(revoke = true) {
  const previousToken = token;
  adminSessionEpoch++;
  loginAttempt++;
  token = '';
  clearPrivateAdminState();
  $('#lerr').textContent = revoke ? '' : 'Sessão expirada. Entre novamente.';
  try { sessionStorage.removeItem('t'); } catch (_) {}
  if (revoke && previousToken) fetch('/api/admin/logout', { method: 'POST', headers: { 'x-token': previousToken } }).catch(() => {});
  showApp();
}

async function api(url, method = 'GET', body) {
  const session = captureAdminSession();
  assertAdminSession(session);
  try {
    const response = await fetch(`/api/admin${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-token': session.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    assertAdminSession(session);
    if (response.status === 401) {
      logout(false);
      throw staleAdminSession();
    }
    const data = await response.json();
    assertAdminSession(session);
    if (!response.ok) {
      const error = new Error(data.error || 'Erro');
      error.status = response.status;
      error.response = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (!adminSessionIsCurrent(session)) throw staleAdminSession();
    error.adminSession = session;
    throw error;
  }
}

$('#login').onsubmit = async event => {
  event.preventDefault();
  const button = $('#login button');
  if (button.disabled) return;
  const attempt = ++loginAttempt;
  const epoch = adminSessionEpoch;
  button.disabled = true;
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#pw').value }),
    });
    const data = await response.json();
    if (attempt !== loginAttempt || epoch !== adminSessionEpoch) {
      if (response.ok && data.token) fetch('/api/admin/logout', { method: 'POST', headers: { 'x-token': data.token } }).catch(() => {});
      return;
    }
    if (!response.ok) throw new Error(data.error);
    adminSessionEpoch++;
    clearPrivateAdminState();
    token = data.token;
    try { sessionStorage.setItem('t', token); } catch (_) {}
    $('#pw').value = '';
    $('#lerr').textContent = '';
    showApp();
  } catch (error) {
    if (attempt === loginAttempt && epoch === adminSessionEpoch) $('#lerr').textContent = error.message;
  } finally { if (attempt === loginAttempt) button.disabled = false; }
};
$('#out').onclick = () => logout();

document.querySelectorAll('.tabs button').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(item => {
      item.setAttribute('aria-pressed', item === button);
    });
    for (const section of ['db', 'pr', 'or', 'kt', 'bn', 'st', 'ps', 'sh']) $(`#${section}`).hidden = button.dataset.t !== section;
    $('#aerr').textContent = '';
    const session = captureAdminSession();
    if (button.dataset.t === 'ps') loadSales().catch(showError);
    else if (button.dataset.t === 'sh') loadSalesHistory().catch(showError);
    else if (button.dataset.t === 'or') loadOrders().catch(showError);
    else if (button.dataset.t === 'kt') loadProducts().then(() => { assertAdminSession(session); return loadKits(); }).catch(showError);
    else if (button.dataset.t !== 'bn') loadProducts().catch(showError);
  };
});

function resetForm() {
  $('#pf').reset();
  $('#pcat-new').value = '';
  refreshProductCategoryOptions();
  $('#pid').value = '';
  $('#pcolor').value = '#b98a4b';
  saleMode = 'weight';
  stockDrafts = { weight: 0, unit: 0 };
  costDrafts = { weight: '', unit: '' };
  updateSaleFields();
  resetImage();
}
$('#rst').onclick = resetForm;

function renderLowStock() {
  const lowStock = products
    .filter(product => stockAmount(product) <= (isUnit(product) ? 3 : LOW_STOCK_GRAMS))
    .sort((a, b) => stockAmount(a) / (isUnit(a) ? 3 : LOW_STOCK_GRAMS) - stockAmount(b) / (isUnit(b) ? 3 : LOW_STOCK_GRAMS) || a.name.localeCompare(b.name, 'pt-BR'));
  const emptyCount = lowStock.filter(product => stockAmount(product) === 0).length;
  $('#low-stock-summary').textContent = lowStock.length
    ? `${lowStock.length} ${lowStock.length === 1 ? 'produto precisa' : 'produtos precisam'} de reposição${emptyCount ? ` · ${emptyCount} ${emptyCount === 1 ? 'esgotado' : 'esgotados'}` : ''}.`
    : 'Nenhum produto precisa de reposição.';
  $('#low-stock-chart').hidden = lowStock.length === 0;
  $('#low-stock-empty').hidden = lowStock.length > 0;
  $('#low-stock-empty').textContent = products.length
    ? 'Nenhum produto com estoque baixo. Todos estão acima de 3 kg ou 3 unidades.'
    : 'Cadastre produtos para acompanhar o estoque aqui.';
  $('#low-stock-bars').innerHTML = lowStock.map(product => `
    <li class="low-stock-row${stockAmount(product) === 0 ? ' is-empty' : ''}" data-stock-product="${product.id}">
      <span class="low-stock-name">${escapeHtml(product.name)}${product.active ? '' : '<small>Oculto na loja</small>'}</span>
      <div class="low-stock-track" aria-hidden="true"><span style="width:${stockAmount(product) / (isUnit(product) ? 3 : LOW_STOCK_GRAMS) * 100}%"></span></div>
      <span class="low-stock-value">${formatAmount(product, stockAmount(product))}${stockAmount(product) === 0 ? '<small>Esgotado</small>' : ''}</span>
      <button type="button" data-stock-edit="${product.id}" aria-label="Editar estoque de ${escapeHtml(product.name)}">Editar</button>
    </li>`).join('');
}

$('#refresh-stock').onclick = async () => {
  const session = captureAdminSession();
  const button = $('#refresh-stock');
  button.disabled = true;
  $('#aerr').textContent = '';
  try {
    await loadProducts();
  } catch (error) {
    showError(error);
  } finally {
    if (adminSessionIsCurrent(session)) button.disabled = false;
  }
};

function editProduct(product) {
  if (!product) return;
  if ($('#pr').hidden) $('.tabs [data-t="pr"]').click();
  $('#pid').value = product.id;
  $('#pname').value = product.name;
  $('#pprice').value = String(product.price).replace('.', ',');
  saleMode = product.sale_unit || 'weight';
  stockDrafts = { weight: product.stock_grams, unit: product.stock_units || 0 };
  $('#psale-unit').value = saleMode;
  $('#pstock').value = stockAmount(product);
  $('#pcost').value = product.cost == null ? '' : String(product.cost).replace('.', ',');
  costDrafts = { weight: '', unit: '', [saleMode]: $('#pcost').value };
  $('#pweight').value = product.price_weight_grams;
  $('#pcat').value = isUncategorizedProduct(product) ? '' : product.category;
  $('#pcat-new').value = '';
  updateNewCategoryField();
  $('#pcolor').value = product.color;
  $('#pdesc').value = product.description;
  $('#pactive').checked = Boolean(product.active);
  $('#ppromo').checked = Boolean(product.tuesday_promo);
  $('#pnew').checked = Boolean(product.is_new);
  updateSaleFields();
  resetImage(product.image_url, product);
  $('#pf').scrollIntoView({ block: 'start' });
  $('#pstock').focus({ preventScroll: true });
}

$('#low-stock-bars').onclick = event => {
  const button = event.target.closest('[data-stock-edit]');
  if (button) editProduct(products.find(product => product.id === Number(button.dataset.stockEdit)));
};

const productFilterIds = ['search', 'category', 'sale', 'stock', 'active'];
const normalizeProductSearch = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
const UNCATEGORIZED_CATEGORY = 'Sem categoria';
// Category names saved by the existing API have a maximum of 30 characters.
const NEW_CATEGORY_OPTION = '__puro_create_new_product_category__';
const isUncategorizedProduct = product => {
  const category = normalizeProductSearch(product.category).replace(/\s+/g, ' ');
  return !category || category === 'geral' || category === 'sem categoria';
};
const productCategories = () => [...new Set(['Cuidados Pessoais', ...products.filter(product => !isUncategorizedProduct(product)).map(product => product.category)])].sort((a, b) => a.localeCompare(b, 'pt-BR'));

function updateNewCategoryField() {
  const creating = $('#pcat').value === NEW_CATEGORY_OPTION;
  $('#pcat-new-label').hidden = !creating;
  $('#pcat-new').disabled = !creating;
  $('#pcat-new').required = creating;
}
$('#pcat').onchange = () => {
  updateNewCategoryField();
  if (!$('#pcat-new').disabled) $('#pcat-new').focus();
};

function refreshProductCategoryOptions() {
  const select = $('#pcat');
  const selected = select.value;
  const categories = productCategories();
  if (selected && selected !== NEW_CATEGORY_OPTION && !categories.includes(selected)) {
    categories.push(selected);
    categories.sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }
  select.innerHTML = '<option value="">Sem categoria</option>'
    + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('')
    + `<option value="${NEW_CATEGORY_OPTION}">Criar nova categoria…</option>`;
  select.value = selected;
  updateNewCategoryField();
}

function refreshProductFilterCategories() {
  const select = $('#product-filter-category');
  const selected = select.value;
  const categories = productCategories();
  select.innerHTML = '<option value="">Todas as categorias</option>'
    + `<option value="${UNCATEGORIZED_CATEGORY}">${UNCATEGORIZED_CATEGORY}</option>`
    + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  select.value = selected === UNCATEGORIZED_CATEGORY || categories.includes(selected) ? selected : '';
}

function productOrderControls(product, filteredIndex, filtered) {
  const position = products.indexOf(product) + 1;
  const previousPosition = filteredIndex ? products.indexOf(filtered[filteredIndex - 1]) + 1 : 0;
  const nextPosition = filteredIndex < filtered.length - 1 ? products.indexOf(filtered[filteredIndex + 1]) + 1 : 0;
  const name = escapeHtml(product.name);
  return `<div class="product-order-controls" role="group" aria-label="Ordem de ${name}">
    <button type="button" class="product-order-arrow is-up" data-product-order="${product.id}" data-order-action="up" data-order-position="${previousPosition}" data-order-edge="${!previousPosition}" aria-label="Mover ${name} para cima" title="Mover para cima"${productOrderBusy || !previousPosition ? ' disabled' : ''}>${adminIcon('arrow')}</button>
    <button type="button" class="product-order-arrow is-down" data-product-order="${product.id}" data-order-action="down" data-order-position="${nextPosition}" data-order-edge="${!nextPosition}" aria-label="Mover ${name} para baixo" title="Mover para baixo"${productOrderBusy || !nextPosition ? ' disabled' : ''}>${adminIcon('arrow')}</button>
    <input id="product-order-${product.id}" type="number" inputmode="numeric" min="1" max="${products.length}" step="1" value="${position}" data-order-position-input="${product.id}" aria-label="Posição de ${name} na loja" aria-describedby="product-order-help"${productOrderBusy ? ' disabled' : ''}>
    <button type="button" data-product-order="${product.id}" data-order-action="move" aria-label="Mover ${name} para a posição informada"${productOrderBusy ? ' disabled' : ''}>Mover</button>
  </div>`;
}

function setProductOrderFeedback(message, error = false) {
  $('#product-order-feedback').textContent = message;
  $('#product-order-feedback').classList.toggle('is-error', error);
}

function updateProductOrderBusy() {
  $('#product-list-table').setAttribute('aria-busy', String(productOrderBusy));
  document.querySelectorAll('#plist [data-product-order]').forEach(button => {
    button.disabled = productOrderBusy || button.dataset.orderEdge === 'true';
  });
  document.querySelectorAll('#plist [data-order-position-input]').forEach(input => { input.disabled = productOrderBusy; });
}

async function moveProductInCatalog(productId, position, trigger) {
  const session = captureAdminSession();
  if (productOrderBusy || !adminSessionIsCurrent(session)) return;
  const product = products.find(item => item.id === productId);
  if (!product) return;
  const input = $(`#product-order-${productId}`);
  if (!Number.isInteger(position) || position < 1 || position > products.length) {
    input.setAttribute('aria-invalid', 'true');
    setProductOrderFeedback(`Informe uma posição inteira entre 1 e ${products.length}.`, true);
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  if (position === products.indexOf(product) + 1) {
    setProductOrderFeedback(`${product.name} já está na posição ${position}.`);
    return;
  }
  const expectedOrder = products.map(item => item.id);
  productOrderBusy = true;
  updateProductOrderBusy();
  setProductOrderFeedback(`Salvando a ordem de ${product.name}…`);
  let saved = false;
  try {
    await api(`/products/${productId}/order`, 'PATCH', { position, expected_order: expectedOrder });
    assertAdminSession(session);
    saved = true;
    await loadProducts();
    assertAdminSession(session);
    const currentPosition = products.findIndex(item => item.id === productId) + 1;
    setProductOrderFeedback(currentPosition ? `${product.name} movido para a posição ${currentPosition}.` : 'A ordem do catálogo foi atualizada.');
  } catch (error) {
    if (ignoreAdminError(error) || !adminSessionIsCurrent(session)) return;
    if (error.status === 409) {
      try {
        await loadProducts();
        assertAdminSession(session);
        setProductOrderFeedback('A lista de produtos mudou. A ordem foi atualizada; escolha a posição novamente.', true);
      } catch (refreshError) {
        if (!ignoreAdminError(refreshError)) setProductOrderFeedback('A lista de produtos mudou, mas não foi possível atualizá-la. Abra a aba Produtos novamente antes de mover.', true);
      }
    } else {
      setProductOrderFeedback(saved ? 'A ordem foi salva, mas não foi possível atualizar a lista. Abra a aba Produtos novamente.' : error.message || 'Não foi possível salvar a ordem dos produtos.', true);
    }
  } finally {
    if (adminSessionIsCurrent(session)) {
      productOrderBusy = false;
      updateProductOrderBusy();
      if (document.activeElement === document.body || document.activeElement === trigger || document.activeElement === input) {
        const action = trigger?.dataset.orderAction || 'move';
        const button = $(`#plist [data-product-order="${productId}"][data-order-action="${action}"]`);
        if (button && !button.disabled) button.focus({ preventScroll: true });
        else $(`#product-order-${productId}`)?.focus({ preventScroll: true });
      }
    }
  }
}

function renderProductList() {
  const filters = Object.fromEntries(productFilterIds.map(id => [id, $(`#product-filter-${id}`).value]));
  const searchWords = normalizeProductSearch(filters.search).split(/\s+/).filter(Boolean);
  const filtered = products.filter(product => {
    const stock = stockAmount(product);
    return searchWords.every(word => normalizeProductSearch(product.name).includes(word))
      && (!filters.category || (filters.category === UNCATEGORIZED_CATEGORY ? isUncategorizedProduct(product) : product.category === filters.category))
      && (!filters.sale || (isUnit(product) ? 'unit' : 'weight') === filters.sale)
      && (!filters.active || Boolean(product.active) === (filters.active === 'visible'))
      && (!filters.stock || (filters.stock === 'empty' ? stock === 0 : filters.stock === 'available' ? stock > 0 : stock <= (isUnit(product) ? 3 : LOW_STOCK_GRAMS)));
  });
  $('#product-filters-clear').disabled = !productFilterIds.some(id => filters[id]);
  $('#product-filter-count').textContent = `${filtered.length} de ${products.length} ${products.length === 1 ? 'produto' : 'produtos'}`;
  $('#product-list-table').hidden = filtered.length === 0;
  $('#product-filter-empty').hidden = filtered.length > 0;
  $('#product-filter-empty').textContent = products.length ? 'Nenhum produto encontrado. Ajuste ou limpe os filtros.' : 'Nenhum produto cadastrado ainda.';
  if (products.length && filters.category === UNCATEGORIZED_CATEGORY && !products.some(isUncategorizedProduct)) {
    $('#product-filter-empty').textContent = 'Nenhum produto sem categoria. Todos os produtos já têm uma categoria definida.';
  }
  $('#product-filter-category-help').hidden = filters.category !== UNCATEGORIZED_CATEGORY;
  $('#plist').innerHTML = filtered.map((product, index) => `
    <tr>
      <td>${product.image_url ? `<img class="product-thumb" src="${escapeHtml(product.image_url)}" alt="" loading="lazy">` : `<span class="dot" style="background:${escapeHtml(product.color)}"></span>`}${escapeHtml(product.name)}${product.active ? '' : ' <em>(oculto)</em>'}<span class="admin-product-badges">${product.tuesday_promo && !isUnit(product) ? '<small>Terça · 20% OFF</small>' : ''}${product.is_new ? '<small>Novidade</small>' : ''}</span></td>
      <td class="product-order-cell" data-label="Ordem na loja">${productOrderControls(product, index, filtered)}</td>
      <td data-label="Categoria">${isUncategorizedProduct(product) ? UNCATEGORIZED_CATEGORY : escapeHtml(product.category)}</td>
      <td data-label="Preço / medida">${formatBrl(product.price)} / ${isUnit(product) ? 'unidade' : formatWeight(product.price_weight_grams)}</td>
      <td data-label="Custo e margem">${productFinance(product)}</td>
      <td data-label="Estoque">${stockAmount(product) === 0 ? 'Esgotado' : formatAmount(product, stockAmount(product))}</td>
      <td><button data-e="${product.id}" aria-label="Editar ${escapeHtml(product.name)}">${adminIcon('edit')} Editar</button> <button data-d="${product.id}" aria-label="Excluir ${escapeHtml(product.name)}">${adminIcon('trash')} Excluir</button></td>
    </tr>`).join('');
}

productFilterIds.forEach(id => {
  $(`#product-filter-${id}`).addEventListener(id === 'search' ? 'input' : 'change', renderProductList);
});
$('#product-filters-clear').onclick = () => {
  productFilterIds.forEach(id => { $(`#product-filter-${id}`).value = ''; });
  renderProductList();
  $('#product-filter-search').focus();
};

async function loadProducts() {
  const session = captureAdminSession();
  const data = await api('/products');
  assertAdminSession(session);
  products = data.products;
  if (typeof refreshKitChoices === 'function') refreshKitChoices();
  if (typeof refreshStockChoices === 'function') refreshStockChoices();
  renderLowStock();
  refreshProductCategoryOptions();
  refreshProductFilterCategories();
  renderProductList();
  await loadDashboard();
  assertAdminSession(session);
  if (!$('#st').hidden) await loadInventory();
  assertAdminSession(session);
}

$('#plist').onclick = async event => {
  const button = event.target.closest?.('[data-e], [data-d], [data-product-order]') || event.target;
  if (button.dataset.productOrder) {
    const id = Number(button.dataset.productOrder);
    const position = button.dataset.orderAction === 'move' ? Number($(`#product-order-${id}`).value) : Number(button.dataset.orderPosition);
    await moveProductInCatalog(id, position, button);
    return;
  }
  if (button.dataset.e) {
    const product = products.find(item => item.id == button.dataset.e);
    editProduct(product);
  }
  if (button.dataset.d && confirm('Excluir este produto? Produtos com pedidos devem ser ocultados em vez de excluídos.')) {
    const session = captureAdminSession();
    try {
      await api(`/products/${button.dataset.d}`, 'DELETE');
      assertAdminSession(session);
      await loadProducts();
    } catch (error) {
      if (adminSessionIsCurrent(session)) showAdminAlert(error);
    }
  }
};

$('#plist').onkeydown = event => {
  if (event.key !== 'Enter' || !event.target.dataset.orderPositionInput) return;
  event.preventDefault();
  const id = Number(event.target.dataset.orderPositionInput);
  moveProductInCatalog(id, Number(event.target.value), event.target).catch(showError);
};

$('#pf').onsubmit = async event => {
  event.preventDefault();
  const session = captureAdminSession();
  if (!adminSessionIsCurrent(session)) return;
  const id = $('#pid').value;
  const category = $('#pcat').value === NEW_CATEGORY_OPTION ? $('#pcat-new').value.trim() : $('#pcat').value;
  if ($('#pcat').value === NEW_CATEGORY_OPTION && !category) {
    showError(new Error('Informe o nome da nova categoria.'));
    $('#pcat-new').focus();
    return;
  }
  $('#aerr').textContent = '';
  const body = {
    name: $('#pname').value,
    description: $('#pdesc').value,
    price: parsePrice($('#pprice').value),
    cost: $('#pcost').value.trim() ? parsePrice($('#pcost').value) : null,
    category: category || 'Geral',
    color: $('#pcolor').value,
    active: $('#pactive').checked,
    tuesday_promo: $('#ppromo').checked,
    is_new: $('#pnew').checked,
    sale_unit: $('#psale-unit').value,
    stock_grams: Number($('#pstock').value),
    stock_units: Number($('#pstock').value),
    price_weight_grams: Number($('#pweight').value),
    image_position_x: Number($('#pimage-x').value),
    image_position_y: Number($('#pimage-y').value),
    image_fit: $('#pimage-fit').value,
  };
  if (!Number.isFinite(body.price)) { alert('Informe um preço válido, como 24,90.'); return; }
  if (body.cost !== null && !Number.isFinite(body.cost)) { alert('Informe um custo válido, como 28,00, ou deixe vazio.'); return; }
  const saveButton = $('#psave');
  saveButton.disabled = true;
  try {
    if (imageChanged) body.image_data_url = selectedImageFile ? await readImage(selectedImageFile) : null;
    assertAdminSession(session);
    await api(id ? `/products/${id}` : '/products', id ? 'PUT' : 'POST', body);
    assertAdminSession(session);
    resetForm();
    await loadProducts();
  } catch (error) {
    if (adminSessionIsCurrent(session)) showAdminAlert(error);
  } finally {
    if (adminSessionIsCurrent(session)) saveButton.disabled = false;
  }
};

const orderStatuses = ['novo', 'confirmado', 'pago', 'entregue', 'cancelado'];
async function loadOrders() {
  const session = captureAdminSession();
  const { orders } = await api('/orders');
  assertAdminSession(session);
  $('#olist').innerHTML = orders.length
    ? orders.map(order => `
      <article class="o">
        <div class="oh">
          <b>${order.sales_channel === 'in_person' ? 'Venda presencial' : 'Pedido'} #${order.id}</b>
          <span>${new Date(order.created_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR')}</span>
          <select data-s="${order.id}" aria-label="Status do pedido ${order.id}">${orderStatuses.map(status =>
            `<option${status === order.status ? ' selected' : ''}>${status}</option>`
          ).join('')}</select>
          <button type="button" class="order-delete" data-order-delete="${order.id}" aria-label="Excluir pedido ${order.id}">${adminIcon('trash')} Excluir pedido</button>
        </div>
        <p>${escapeHtml(order.customer)} · ${escapeHtml(order.phone || 'sem telefone')}${order.phone ? ` · <a target="_blank" rel="noopener" href="${whatsappUrl(order.phone)}">chamar no WhatsApp</a>` : ''}<br>${escapeHtml(order.address || '')}${order.notes ? `<br><em>${escapeHtml(order.notes)}</em>` : ''}<br><strong>${order.sales_channel === 'in_person' ? `Venda na loja · ${escapeHtml(({ pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', outro: 'Outro' })[order.payment_method] || order.payment_method)}` : order.delivery_method === 'pickup' ? 'Retirada na loja' : order.free_shipping ? 'Frete grátis · Maracanaú' : `Frete a combinar${order.delivery_city ? ` · ${escapeHtml(order.delivery_city)}` : ''}`}</strong></p>
        <ul>${order.items.map(item => `<li>${item.qty}x ${escapeHtml(item.name)}${item.sale_unit === 'unit' ? ` (${formatUnits(item.qty)})` : item.weight_grams ? ` (${formatWeight(item.weight_grams)} por porção)` : ''} – ${formatBrl(item.price_cents * item.qty / 100)}</li>`).join('')}</ul>
        <b>Total: ${formatBrl(order.total_cents / 100)}</b>
        <p class="order-profit">${order.profit ? `Custo dos produtos: ${formatBrl(order.profit.cost_cents / 100)} · Lucro bruto estimado: ${formatBrl(order.profit.profit_cents / 100)} · Margem: ${formatMargin(order.profit.margin_percent)}` : 'Lucro bruto não calculado: custo não informado em um ou mais itens.'}</p>
      </article>`).join('')
    : '<p>Nenhum pedido ainda.</p>';
}

$('#olist').onclick = async event => {
  const button = event.target.closest('button[data-order-delete]');
  if (!button || button.disabled) return;
  const id = button.dataset.orderDelete;
  if (!confirm(`Excluir definitivamente o pedido #${id}? Ele será removido do histórico e dos totais do dashboard. O estoque não será alterado. Para devolver os itens ao estoque, cancele o pedido antes de excluir.`)) return;
  const session = captureAdminSession();
  if (!adminSessionIsCurrent(session)) return;
  const status = button.closest('.o').querySelector('select[data-s]');
  button.disabled = status.disabled = true;
  $('#aerr').textContent = '';
  try {
    await api(`/orders/${id}`, 'DELETE');
    assertAdminSession(session);
    await Promise.all([loadOrders(), loadProducts()]);
  } catch (error) {
    if (adminSessionIsCurrent(session)) showError(error);
  } finally {
    if (adminSessionIsCurrent(session)) button.disabled = status.disabled = false;
  }
};

$('#olist').onchange = async event => {
  if (!event.target.dataset.s) return;
  const session = captureAdminSession();
  if (!adminSessionIsCurrent(session)) return;
  const previousStatus = event.target.querySelector('option[selected]')?.value || 'novo';
  const deleteButton = event.target.closest('.o').querySelector('[data-order-delete]');
  deleteButton.disabled = true;
  event.target.disabled = true;
  try {
    await api(`/orders/${event.target.dataset.s}`, 'PATCH', { status: event.target.value });
    assertAdminSession(session);
    await Promise.all([loadOrders(), loadProducts()]);
  } catch (error) {
    if (adminSessionIsCurrent(session)) {
      event.target.value = previousStatus;
      showAdminAlert(error);
    }
  } finally {
    if (adminSessionIsCurrent(session)) {
      event.target.disabled = false;
      deleteButton.disabled = false;
    }
  }
};

document.addEventListener('DOMContentLoaded', showApp, { once: true });
