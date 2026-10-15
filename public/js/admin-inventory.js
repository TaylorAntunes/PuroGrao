const movementReasons = { initial: 'Saldo inicial', purchase: 'Compra / reposição', manual_adjustment: 'Ajuste manual',
  product_edit: 'Ajuste no cadastro', sale: 'Venda', cancellation: 'Cancelamento', reopening: 'Reabertura de pedido' };
let movementOffset = 0;
let movementLoadSequence = 0;

function refreshStockChoices() {
  const select = $('#movement-product');
  const previous = select.value;
  select.innerHTML = '<option value="">Escolha um produto</option>' + products.map(product => `<option value="${product.id}">${escapeHtml(product.name)}${product.active ? '' : ' (oculto)'}</option>`).join('');
  select.value = previous;
  updateMovementPreview();
}

function updateMovementPreview() {
  const product = products.find(product => product.id === Number($('#movement-product').value));
  const purchase = $('#movement-reason').value === 'purchase';
  if (purchase) $('#movement-direction').value = 'in';
  $('#movement-direction').disabled = purchase;
  $('#movement-quantity-label').textContent = product && isUnit(product) ? 'Quantidade (unidades)' : 'Quantidade (g)';
  if (!product) {
    $('#movement-current').textContent = 'Escolha um produto para consultar o saldo.';
    return;
  }
  const quantity = Number($('#movement-quantity').value);
  const next = stockAmount(product) + ($('#movement-direction').value === 'out' ? -quantity : quantity);
  $('#movement-current').textContent = `Saldo atual: ${formatAmount(product, stockAmount(product))}${Number.isSafeInteger(quantity) && quantity > 0 && Number.isSafeInteger(next) && next >= 0 ? ` · Após a movimentação: ${formatAmount(product, next)}` : ''}${isUnit(product) ? '' : ' · 1 kg = 1.000 g'}`;
}

async function loadInventory() {
  const session = captureAdminSession();
  const sequence = ++movementLoadSequence;
  const filters = new URLSearchParams({ offset: movementOffset });
  if ($('#stock-history-product').value) filters.set('product_id', $('#stock-history-product').value);
  if ($('#stock-history-reason').value) filters.set('reason', $('#stock-history-reason').value);
  const data = await api(`/stock-movements?${filters}`);
  assertAdminSession(session);
  if (sequence !== movementLoadSequence) return;
  movementOffset = data.offset;
  const selected = $('#stock-history-product').value;
  $('#stock-history-product').innerHTML = '<option value="">Todos os produtos</option>' + data.products.map(product => `<option value="${product.id}">${escapeHtml(product.name)}${product.deleted ? ' (excluído)' : ''}</option>`).join('');
  $('#stock-history-product').value = selected;
  $('#stock-history-rows').innerHTML = data.movements.map(movement => {
    const amount = Math.abs(movement.delta);
    const signed = `${movement.delta > 0 ? '+' : movement.delta < 0 ? '−' : ''}${formatAmount(movement, amount)}`;
    const date = new Date(movement.created_at.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return `<tr><td data-label="Data">${escapeHtml(date)}</td><td data-label="Produto">${escapeHtml(movement.product_name)}</td><td data-label="Movimentação"><strong class="${movement.delta > 0 ? 'movement-in' : movement.delta < 0 ? 'movement-out' : ''}">${signed}</strong></td><td data-label="Saldo após">${formatAmount(movement, movement.balance)}</td><td data-label="Motivo / pedido">${movementReasons[movement.reason]}${movement.order_id ? ` · Pedido #${movement.order_id}` : ''}${movement.note ? `<small class="finance-detail">${escapeHtml(movement.note)}</small>` : ''}</td></tr>`;
  }).join('');
  $('#stock-history-empty').hidden = data.total > 0;
  $('#stock-history-table').hidden = !data.movements.length;
  $('#stock-history-prev').disabled = data.offset === 0;
  $('#stock-history-next').disabled = data.offset + data.limit >= data.total;
  $('#stock-history-page').textContent = data.total ? `${data.offset + 1}–${Math.min(data.offset + data.limit, data.total)} de ${data.total}` : '0 movimentações';
}

function clearInventorySession() {
  movementOffset = 0;
  movementLoadSequence++;
  $('#stock-history-product').innerHTML = '<option value="">Todos os produtos</option>';
  $('#stock-history-reason').value = '';
  $('#stock-history-rows').innerHTML = '';
  $('#stock-history-empty').hidden = true;
  $('#stock-history-table').hidden = true;
  $('#stock-history-prev').disabled = $('#stock-history-next').disabled = true;
  $('#stock-history-page').textContent = '0 movimentações';
  $('#movement-product').value = '';
  $('#movement-quantity').value = $('#movement-note').value = '';
  $('#movement-feedback').textContent = '';
  $('#movement-feedback').classList.remove('err');
  refreshStockChoices();
}

$('#movement-product').onchange = () => { $('#movement-quantity').value = ''; updateMovementPreview(); };
for (const selector of ['#movement-reason', '#movement-direction', '#movement-quantity']) $(selector).addEventListener('input', updateMovementPreview);
for (const selector of ['#stock-history-product', '#stock-history-reason']) $(selector).onchange = () => { movementOffset = 0; loadInventory().catch(showError); };
$('#stock-history-prev').onclick = () => { movementOffset = Math.max(0, movementOffset - 50); loadInventory().catch(showError); };
$('#stock-history-next').onclick = () => { movementOffset += 50; loadInventory().catch(showError); };
$('#refresh-stock-history').onclick = async () => {
  const session = captureAdminSession();
  const button = $('#refresh-stock-history');
  button.disabled = true;
  $('#aerr').textContent = '';
  try { await loadProducts(); } catch (error) { showError(error); }
  finally { if (adminSessionIsCurrent(session)) button.disabled = false; }
};

$('#stock-movement-form').onsubmit = async event => {
  event.preventDefault();
  const session = captureAdminSession();
  if (!adminSessionIsCurrent(session)) return;
  const product = products.find(product => product.id === Number($('#movement-product').value));
  const quantity = Number($('#movement-quantity').value);
  const feedback = $('#movement-feedback');
  feedback.textContent = '';
  feedback.classList.remove('err');
  if (!product || !Number.isSafeInteger(quantity) || quantity < 1) {
    feedback.classList.add('err'); feedback.textContent = 'Escolha um produto e uma quantidade inteira positiva.'; return;
  }
  const body = { product_id: product.id, sale_unit: product.sale_unit, delta: $('#movement-direction').value === 'out' ? -quantity : quantity,
    reason: $('#movement-reason').value, note: $('#movement-note').value };
  const controls = [...$('#stock-movement-form').querySelectorAll('input, select, textarea, button')];
  controls.forEach(control => { control.disabled = true; });
  try {
    await api('/stock-movements', 'POST', body);
    assertAdminSession(session);
    $('#movement-quantity').value = $('#movement-note').value = '';
    movementOffset = 0;
    feedback.textContent = 'Movimentação registrada.';
    await loadProducts();
  } catch (error) {
    if (adminSessionIsCurrent(session) && !ignoreAdminError(error)) {
      feedback.classList.add('err'); feedback.textContent = error.message;
    }
  } finally {
    if (adminSessionIsCurrent(session)) {
      controls.forEach(control => { control.disabled = false; });
      updateMovementPreview();
    }
  }
};
refreshStockChoices();
