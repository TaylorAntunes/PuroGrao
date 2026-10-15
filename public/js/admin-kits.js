let adminKits = [];

function kitComponents() {
  return [...document.querySelectorAll('.kit-component')].map(row => {
    const id = Number(row.querySelector('select').value);
    const unit = isUnit(products.find(product => product.id === id) || {});
    return { id, ...(unit ? { sale_unit: 'unit' } : {}), weight_grams: unit ? 0 : Number(row.querySelector('[data-kit-weight]').value), qty: Number(row.querySelector('[data-kit-qty]').value) };
  });
}
function updateKitMeasures() {
  document.querySelectorAll('.kit-component').forEach(row => {
    const unit = isUnit(products.find(product => product.id === Number(row.querySelector('select').value)) || {});
    row.querySelector('[data-kit-weight-label]').hidden = unit;
    row.querySelector('[data-kit-weight]').disabled = unit;
    row.querySelector('[data-kit-weight]').required = !unit;
    row.querySelector('[data-kit-qty-label]').textContent = unit ? 'Unidades' : 'Porções';
  });
}
function refreshKitChoices() {
  document.querySelectorAll('.kit-component select').forEach(select => {
    const saved = select.value;
    select.innerHTML = '<option value="">Escolha um produto</option>' + products.map(product => `<option value="${product.id}">${escapeHtml(product.name)}${product.active ? '' : ' (oculto)'}</option>`).join('');
    select.value = saved;
  });
  updateKitPreview();
}
function updateKitPreview() {
  updateKitMeasures();
  const items = kitComponents();
  const valid = items.length && items.every(item => products.some(product => product.id === item.id) && (item.sale_unit === 'unit' || Number.isInteger(item.weight_grams) && item.weight_grams > 0 && item.weight_grams <= MAX_WEIGHT_GRAMS) && Number.isInteger(item.qty) && item.qty > 0 && item.qty <= 99);
  const total = valid ? items.reduce((sum, item) => {
    const product = products.find(product => product.id === item.id);
    return sum + portionPrice(product, item.weight_grams) * item.qty;
  }, 0) : 0;
  $('#kit-price-preview').textContent = valid ? `Preço normal do kit: ${formatBrl(total / 100)}. Descontos ativos dos produtos são aplicados na loja.` : 'Escolha os produtos para calcular o preço do kit.';
}
function addKitComponent(item = {}) {
  const row = document.createElement('div');
  row.className = 'kit-component';
  row.innerHTML = `<label>Produto<select required></select></label><label data-kit-weight-label>Peso por porção (g)<input data-kit-weight type="number" min="1" max="100000" step="1" value="${item.weight_grams || 100}" required></label><label><span data-kit-qty-label>Porções</span><input data-kit-qty type="number" min="1" max="99" step="1" value="${item.qty || 1}" required></label><button type="button" data-kit-remove aria-label="Remover produto do kit">Remover</button>`;
  $('#kit-components').append(row);
  refreshKitChoices();
  row.querySelector('select').value = String(item.id || '');
  updateKitPreview();
}
function resetKitForm() {
  $('#kit-form').reset();
  $('#kit-id').value = '';
  $('#kit-components').innerHTML = '';
  addKitComponent();
}
$('#kit-add-component').onclick = () => {
  if (kitComponents().length >= 20) { showError(new Error('O kit pode ter até 20 produtos.')); return; }
  addKitComponent();
};
$('#kit-components').onclick = event => {
  if (event.target.closest('[data-kit-remove]')) { event.target.closest('.kit-component').remove(); updateKitPreview(); }
};
$('#kit-components').oninput = $('#kit-components').onchange = updateKitPreview;
$('#kit-reset').onclick = resetKitForm;
$('#kit-templates').onclick = event => {
  if (!event.target.matches('button')) return;
  resetKitForm();
  $('#kit-name').value = event.target.textContent;
  $('#kit-name').focus();
};
async function loadKits() {
  const session = captureAdminSession();
  const data = await api('/kits');
  assertAdminSession(session);
  adminKits = data.kits;
  $('#kit-list').innerHTML = adminKits.length ? adminKits.map(kit => `<article class="o"><h3>${escapeHtml(kit.name)}${kit.active ? '' : ' (oculto)'}</h3><p>${escapeHtml(kit.description)}</p><p>${kit.components.map(item => {
    const product = products.find(product => product.id === item.id);
    return `${item.qty}× ${escapeHtml(product?.name || 'Produto indisponível')} (${item.sale_unit === 'unit' ? 'unidade' : formatWeight(item.weight_grams)})${product && (product.sale_unit || 'weight') !== (item.sale_unit || 'weight') ? ' — forma de venda alterada; revise este kit' : ''}`;
  }).join(' · ')}</p><button type="button" data-edit-kit="${kit.id}">Editar</button> <button type="button" data-delete-kit="${kit.id}">Excluir</button></article>`).join('') : '<p>Nenhum kit cadastrado. Escolha um nome acima e monte a composição.</p>';
}
function clearKitsSession() {
  adminKits = [];
  $('#kit-list').innerHTML = '';
  resetKitForm();
}
$('#kit-list').onclick = async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.editKit) {
    const kit = adminKits.find(item => item.id === Number(button.dataset.editKit));
    $('#kit-id').value = kit.id;
    $('#kit-name').value = kit.name;
    $('#kit-description').value = kit.description;
    $('#kit-active').checked = Boolean(kit.active);
    $('#kit-components').innerHTML = '';
    kit.components.forEach(addKitComponent);
    $('#kit-form').scrollIntoView({ block: 'start' });
  } else if (button.dataset.deleteKit && confirm('Excluir este kit? Os produtos e os pedidos já salvos serão preservados.')) {
    const session = captureAdminSession();
    try { await api(`/kits/${button.dataset.deleteKit}`, 'DELETE'); assertAdminSession(session); await loadKits(); } catch (error) { showError(error); }
  }
};
$('#kit-form').onsubmit = async event => {
  event.preventDefault();
  const session = captureAdminSession();
  if (!adminSessionIsCurrent(session)) return;
  $('#kit-save').disabled = true;
  $('#aerr').textContent = '';
  try {
    const id = $('#kit-id').value;
    await api(id ? `/kits/${id}` : '/kits', id ? 'PUT' : 'POST', {
      name: $('#kit-name').value, description: $('#kit-description').value,
      active: $('#kit-active').checked, components: kitComponents(),
    });
    assertAdminSession(session);
    resetKitForm();
    await loadKits();
  } catch (error) { showError(error); } finally { if (adminSessionIsCurrent(session)) $('#kit-save').disabled = false; }
};
resetKitForm();
