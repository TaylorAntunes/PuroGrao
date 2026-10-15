// In-person sales use the existing pricing, orders and inventory APIs.
(function (root) {
  const paymentNames = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', outro: 'Outro' };
  const statusNames = { pendente: 'Pendente', pago: 'Pago', entregue: 'Entregue', cancelado: 'Cancelado' };
  const query = selector => document.querySelector(selector);
  const money = cents => formatBrl(cents / 100);
  let mounted = false;
  let catalog = [];
  let recentSales = [];
  let lines = [];
  let lineSequence = 0;
  let sessionEpoch = 0;
  let loadSequence = 0;
  let maxWeight = PuroPricing.MAX_WEIGHT_GRAMS;
  let mode = 'idle';
  let pendingPayload = null;
  let pendingLineTotals = new Map();
  let pendingSaved = false;
  const pendingStorageKey = 'puro-grao-admin-pending-sale';

  function clearPendingStorage() {
    pendingSaved = false;
    try { sessionStorage.removeItem(pendingStorageKey); } catch (_) {}
  }

  function savePending() {
    try {
      sessionStorage.setItem(pendingStorageKey, JSON.stringify({ owner: token, payload: pendingPayload,
        lines, line_totals: [...pendingLineTotals] }));
      pendingSaved = true;
    } catch (_) { pendingSaved = false; }
  }

  function uncertainMessage() {
    return 'Não foi possível confirmar o registro. Os itens estão protegidos para evitar uma venda duplicada. Clique em “Verificar registro” para consultar e repetir esta mesma operação com segurança.' +
      (pendingSaved ? '' : ' Mantenha esta aba aberta até verificar o registro; o navegador não permitiu salvar esta operação para uma recarga da página.');
  }

  function restorePending() {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(pendingStorageKey) || 'null'); } catch (_) { return; }
    if (!saved) return;
    const payload = saved.payload;
    const valid = saved.owner === token && token && payload &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.request_id || '') &&
      Number.isSafeInteger(payload.expected_total_cents) && payload.expected_total_cents >= 0 &&
      Object.hasOwn(paymentNames, payload.payment_method) && Array.isArray(saved.lines) && saved.lines.length > 0 && saved.lines.length <= 50 &&
      Array.isArray(payload.items) && payload.items.length === saved.lines.length && Array.isArray(saved.line_totals) &&
      saved.lines.every((line, index) => Number.isSafeInteger(line.key) && line.key > 0 && Number.isSafeInteger(line.id) && line.id > 0 &&
        ['unit', 'weight'].includes(line.sale_unit) && Number.isSafeInteger(line.qty) && line.qty >= 1 && line.qty <= 99 &&
        Number.isSafeInteger(line.weight_grams) && (line.sale_unit === 'unit' ? line.weight_grams === 0 : line.weight_grams >= 1 && line.weight_grams <= PuroPricing.MAX_WEIGHT_GRAMS) &&
        payload.items[index]?.id === line.id && payload.items[index]?.sale_unit === line.sale_unit &&
        payload.items[index]?.qty === line.qty && payload.items[index]?.weight_grams === line.weight_grams);
    if (!valid) { clearPendingStorage(); return; }
    lines = saved.lines;
    lineSequence = Math.max(lineSequence, ...lines.map(line => line.key));
    pendingPayload = payload;
    pendingLineTotals = new Map((saved.line_totals || []).filter(entry => Array.isArray(entry) && Number.isSafeInteger(entry[0]) && Number.isSafeInteger(entry[1]) && entry[1] >= 0));
    pendingSaved = true;
    query('#sales-payment').value = payload.payment_method;
    query('#sales-customer').value = payload.customer || '';
    query('#sales-notes').value = payload.notes || '';
    renderLines();
    setMode('uncertain');
    notify('Há uma venda aguardando confirmação da sessão anterior. Clique em “Verificar registro” antes de iniciar outra venda.', 'warning');
  }

  function mount() {
    const workspace = query('#sales-workspace');
    if (mounted || !workspace) return Boolean(workspace);
    workspace.innerHTML = `
      <div class="sales-layout">
        <section class="sales-card" aria-labelledby="sales-products-heading">
          <h3 id="sales-products-heading">Escolha os produtos</h3>
          <fieldset id="sales-selection-fields" class="sales-fields">
            <legend class="sr-only">Adicionar produtos à venda</legend>
            <div class="sales-filters">
              <label for="sales-search">Buscar produto<input id="sales-search" type="search" placeholder="Nome do produto" autocomplete="off" aria-controls="sales-search-matches"></label>
              <label for="sales-category">Categoria<select id="sales-category"><option value="">Todas as categorias</option></select></label>
            </div>
            <div id="sales-search-results" class="sales-search-results" hidden><p id="sales-search-status" class="sales-muted" role="status" aria-live="polite"></p><ul id="sales-search-matches" class="sales-search-matches" aria-label="Produtos encontrados"></ul></div>
            <label for="sales-product-select">Produto<select id="sales-product-select"><option value="">Escolha um produto</option></select></label>
            <p id="sales-product-detail" class="sales-product-detail">Carregando produtos…</p>
            <div class="sales-measures">
              <label id="sales-weight-label" for="sales-weight" hidden>Peso por porção (g)<input id="sales-weight" type="number" inputmode="numeric" min="1" max="100000" step="1" value="100"></label>
              <div class="sales-quantity-field"><label id="sales-quantity-label" for="sales-quantity">Quantidade</label><div class="sales-stepper"><button type="button" data-sales-step="-1" aria-label="Diminuir quantidade">−</button><input id="sales-quantity" type="number" inputmode="numeric" min="1" max="99" step="1" value="1"><button type="button" data-sales-step="1" aria-label="Aumentar quantidade">+</button></div></div>
            </div>
            <div id="sales-weight-options" class="sales-weight-options" hidden><button type="button" data-sales-weight="100">100 g</button><button type="button" data-sales-weight="250">250 g</button><button type="button" data-sales-weight="500">500 g</button><button type="button" data-sales-weight="1000">1 kg</button></div>
            <div class="sales-add-summary"><span id="sales-selected-price">Selecione um produto</span><button id="sales-add" class="p" type="button" disabled>Adicionar à venda</button></div>
          </fieldset>
        </section>
        <section class="sales-card sales-receipt" aria-labelledby="sales-receipt-heading">
          <div class="sales-heading"><h3 id="sales-receipt-heading">Venda atual</h3><button id="sales-clear" type="button" class="sales-text-action" disabled>Limpar itens</button></div>
          <form id="sales-form">
            <fieldset id="sales-receipt-fields" class="sales-fields">
              <legend class="sr-only">Itens e dados da venda</legend>
              <p id="sales-empty" class="sales-empty">Adicione produtos para começar a venda.</p>
              <div id="sales-lines" class="sales-lines"></div>
              <p id="sales-validation" class="sales-validation" role="status"></p>
              <div class="sales-total-row"><span>Total da venda<small>Preços e descontos do catálogo atual.</small></span><strong id="sales-total">${money(0)}</strong></div>
              <label for="sales-payment">Forma de pagamento<select id="sales-payment" required><option value="">Escolha a forma de pagamento</option>${Object.entries(paymentNames).map(([key, value]) => `<option value="${key}">${value}</option>`).join('')}</select></label>
              <label for="sales-customer">Nome do cliente <span class="sales-optional">(opcional)</span><input id="sales-customer" type="text" maxlength="80" autocomplete="off" placeholder="Ex.: Maria"></label>
              <label for="sales-notes">Observações <span class="sales-optional">(opcional)</span><textarea id="sales-notes" rows="2" maxlength="300" placeholder="Informações sobre esta venda"></textarea></label>
              <button id="sales-register" class="p sales-register" type="submit" disabled>Registrar venda paga</button>
              <p class="sales-record-help">Confirme o recebimento antes de registrar. Esta ação dá baixa nos produtos e não cobra o cliente.</p>
            </fieldset>
          </form>
        </section>
      </div>
      <div id="sales-feedback" class="sales-feedback" role="status" aria-live="polite" tabindex="-1"></div>
      <button id="sales-retry" class="p" type="button" hidden>Verificar registro</button>
      <section class="sales-history-section" aria-labelledby="sales-history-heading">
        <div class="sales-heading"><div><h3 id="sales-history-heading">Vendas presenciais recentes</h3><p class="sales-muted">Últimos 50 registros. Cancelar uma venda devolve os produtos ao estoque.</p></div><button id="sales-refresh" type="button">Atualizar</button></div>
        <div id="sales-history" class="sales-history"><p class="sales-empty">Carregando vendas…</p></div>
      </section>`;
    mounted = true;
    workspace.addEventListener('click', handleClick);
    workspace.addEventListener('input', handleInput);
    workspace.addEventListener('change', handleChange);
    workspace.addEventListener('keydown', handleSearchKey);
    query('#sales-form').addEventListener('submit', event => { event.preventDefault(); registerSale(); });
    restorePending();
    return true;
  }

  function notify(message = '', kind = '') {
    const feedback = query('#sales-feedback');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.className = `sales-feedback${kind ? ` is-${kind}` : ''}`;
  }

  function chosenProduct() {
    return catalog.find(product => product.id === Number(query('#sales-product-select').value));
  }

  function lineProduct(line) {
    return catalog.find(product => product.id === line.id && product.sale_unit === line.sale_unit);
  }

  function stockUsed(id, saleUnit, candidates = lines) {
    return candidates.filter(line => line.id === id && line.sale_unit === saleUnit)
      .reduce((sum, line) => sum + line.qty * (saleUnit === 'unit' ? 1 : line.weight_grams), 0);
  }

  function analyze(candidates = lines) {
    let total = 0;
    const errors = [];
    const quantities = new Map();
    if (candidates.length > 50) errors.push('A venda aceita até 50 itens diferentes.');
    for (const line of candidates) {
      const product = lineProduct(line);
      if (!product) { errors.push(`${line.name}: produto indisponível ou tipo de venda alterado. Remova o item e selecione-o novamente.`); continue; }
      quantities.set(line.id, (quantities.get(line.id) || 0) + line.qty);
      if (!Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > 99 ||
          (!isUnit(product) && (!Number.isSafeInteger(line.weight_grams) || line.weight_grams < 1 || line.weight_grams > maxWeight))) {
        errors.push(`${product.name}: informe uma quantidade inteira de 1 a 99 e, para peso, de 1 a ${maxWeight.toLocaleString('pt-BR')} g.`);
        continue;
      }
      total += portionPrice(product, line.weight_grams) * line.qty;
    }
    for (const [id, quantity] of quantities) {
      const product = catalog.find(item => item.id === id);
      if (quantity > 99) errors.push(`${product.name}: o limite é de 99 unidades ou porções por produto.`);
      const required = stockUsed(id, product.sale_unit, candidates);
      if (required > stockAmount(product)) errors.push(`${product.name}: estoque disponível de ${formatAmount(product, stockAmount(product))}.`);
    }
    if (!Number.isSafeInteger(total) || total < 0) errors.push('O total da venda ultrapassa o limite permitido.');
    return { total, errors: [...new Set(errors)] };
  }

  function productOptions() {
    const select = query('#sales-product-select');
    const previous = select.value;
    const search = query('#sales-search').value.trim();
    const category = query('#sales-category').value;
    const filtered = catalog.filter(product => (!search || ProductSearch.matches({ name: product.name }, search)) && (!category || product.category === category));
    select.innerHTML = `<option value="">${filtered.length ? 'Escolha um produto' : 'Nenhum produto encontrado'}</option>` + filtered.map(product => `<option value="${product.id}">${escapeHtml(product.name)}${product.active ? '' : ' · Oculto na loja'}${stockAmount(product) <= 0 ? ' · Esgotado' : ''}</option>`).join('');
    select.value = filtered.some(product => String(product.id) === previous) ? previous : '';
    query('#sales-search-results').hidden = !search;
    query('#sales-search-status').textContent = filtered.length
      ? `${filtered.length} ${filtered.length === 1 ? 'produto encontrado' : 'produtos encontrados'}. Selecione o produto abaixo.`
      : `Nenhum produto encontrado.${category ? ' Tente outra categoria ou selecione Todas as categorias.' : ' Tente outro nome.'}`;
    query('#sales-search-matches').innerHTML = search ? filtered.map(product => {
      const reference = isUnit(product) ? 'unidade' : formatWeight(product.price_weight_grams);
      return `<li><button type="button" data-sales-product="${product.id}" aria-pressed="${String(product.id) === select.value}"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.category)} · ${money(portionPrice(product, product.price_weight_grams))} / ${reference}${stockAmount(product) <= 0 ? ' · Esgotado' : ''}${product.active ? '' : ' · Oculto no catálogo online'}</span></button></li>`;
    }).join('') : '';
    updateSelection();
  }

  function selectProduct(id) {
    query('#sales-product-select').value = String(id);
    query('#sales-quantity').value = 1;
    query('#sales-weight').value = 100;
    for (const button of query('#sales-search-matches').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.salesProduct === query('#sales-product-select').value));
    }
    updateSelection();
  }

  function handleSearchKey(event) {
    if (mode !== 'idle') return;
    const buttons = [...query('#sales-search-matches').querySelectorAll('button')];
    if (event.target.id === 'sales-search' && event.key === 'ArrowDown' && buttons.length) {
      event.preventDefault();
      buttons[0].focus();
    } else if (event.target.matches('[data-sales-product]')) {
      const index = buttons.indexOf(event.target);
      if (event.key === 'ArrowDown' && index < buttons.length - 1) {
        event.preventDefault(); buttons[index + 1].focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault(); (index > 0 ? buttons[index - 1] : query('#sales-search')).focus();
      } else if (event.key === 'Escape') {
        event.preventDefault(); query('#sales-search').focus();
      }
    }
  }

  function updateSelection() {
    const product = chosenProduct();
    const weight = product && !isUnit(product);
    query('#sales-weight-label').hidden = !weight;
    query('#sales-weight-options').hidden = !weight;
    query('#sales-weight').max = maxWeight;
    query('#sales-quantity-label').textContent = weight ? 'Número de porções' : 'Quantidade (unidades)';
    if (!product) {
      query('#sales-product-detail').textContent = catalog.length ? 'Produtos ocultos na loja também podem ser vendidos aqui.' : 'Nenhum produto cadastrado.';
      query('#sales-selected-price').textContent = 'Selecione um produto';
      query('#sales-add').disabled = true;
      return;
    }
    const remaining = stockAmount(product) - stockUsed(product.id, product.sale_unit);
    const reference = isUnit(product) ? 'por unidade' : `por ${formatWeight(product.price_weight_grams)}`;
    query('#sales-product-detail').textContent = `${money(portionPrice(product, product.price_weight_grams))} ${reference} · Estoque: ${formatAmount(product, stockAmount(product))}${remaining !== stockAmount(product) ? ` · Disponível para adicionar: ${formatAmount(product, Math.max(0, remaining))}` : ''}${product.active ? '' : ' · Oculto no catálogo online'}${product.discount_percent ? ` · ${product.discount_percent}% de desconto vigente` : ''}`;
    const qty = Number(query('#sales-quantity').value);
    const grams = weight ? Number(query('#sales-weight').value) : 0;
    const valid = Number.isSafeInteger(qty) && qty > 0 && qty <= 99 && (!weight || Number.isSafeInteger(grams) && grams > 0 && grams <= maxWeight);
    query('#sales-selected-price').textContent = valid ? money(portionPrice(product, grams) * qty) : 'Informe uma quantidade válida';
    query('#sales-add').disabled = mode !== 'idle' || !valid || remaining < qty * (weight ? grams : 1);
    for (const button of query('#sales-weight-options').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.salesWeight) === grams));
    }
  }

  function renderLines() {
    query('#sales-empty').hidden = lines.length > 0;
    query('#sales-lines').innerHTML = lines.map(line => {
      const product = lineProduct(line);
      const weight = line.sale_unit !== 'unit';
      const priceValid = product && Number.isSafeInteger(line.qty) && line.qty > 0 && (!weight || Number.isSafeInteger(line.weight_grams) && line.weight_grams > 0 && line.weight_grams <= maxWeight);
      const total = pendingPayload && pendingLineTotals.has(line.key) ? money(pendingLineTotals.get(line.key)) : priceValid ? money(portionPrice(product, line.weight_grams) * line.qty) : '—';
      return `<article class="sales-line" data-sales-line="${line.key}"><div class="sales-line-heading"><strong>${escapeHtml(product?.name || line.name)}</strong><button class="sales-remove" type="button" data-remove-line="${line.key}" aria-label="Remover ${escapeHtml(product?.name || line.name)}">${adminIcon('trash')}<span>Remover</span></button></div><span class="sales-line-detail">${weight ? 'Produto por peso' : 'Produto por unidade'}${product?.discount_percent ? ` · ${product.discount_percent}% OFF` : ''}${product && !product.active ? ' · Oculto na loja' : ''}</span><div class="sales-line-controls">${weight ? `<label>Peso por porção (g)<input type="number" min="1" max="${maxWeight}" step="1" inputmode="numeric" value="${line.weight_grams}" data-line-field="weight_grams"></label>` : ''}<label>${weight ? 'Porções' : 'Unidades'}<input type="number" min="1" max="99" step="1" inputmode="numeric" value="${line.qty}" data-line-field="qty"></label><strong data-line-total="${line.key}">${total}</strong></div></article>`;
    }).join('');
    updateTotals();
  }

  function updateTotals() {
    const result = analyze();
    query('#sales-total').textContent = money(pendingPayload ? pendingPayload.expected_total_cents : Number.isSafeInteger(result.total) ? result.total : 0);
    query('#sales-validation').textContent = pendingPayload ? '' : result.errors.join(' ');
    query('#sales-register').disabled = mode !== 'idle' || !lines.length || result.errors.length > 0 || !query('#sales-payment').value;
    query('#sales-clear').disabled = mode !== 'idle' || !lines.length;
    for (const line of lines) {
      const product = lineProduct(line);
      const target = query(`[data-line-total="${line.key}"]`);
      const valid = product && Number.isSafeInteger(line.qty) && line.qty > 0 && (isUnit(product) || Number.isSafeInteger(line.weight_grams) && line.weight_grams > 0 && line.weight_grams <= maxWeight);
      if (target) target.textContent = pendingPayload && pendingLineTotals.has(line.key) ? money(pendingLineTotals.get(line.key)) : valid ? money(portionPrice(product, line.weight_grams) * line.qty) : '—';
    }
    updateSelection();
  }

  function setMode(next) {
    mode = next;
    const locked = mode !== 'idle';
    query('#sales-selection-fields').disabled = locked;
    query('#sales-receipt-fields').disabled = locked;
    query('#sales-refresh').disabled = locked;
    query('#sales-retry').hidden = mode !== 'uncertain';
    query('#sales-retry').disabled = mode !== 'uncertain';
    for (const button of query('#sales-history').querySelectorAll('button')) button.disabled = locked;
    query('#sales-register').textContent = mode === 'posting' ? 'Registrando…' : 'Registrar venda paga';
    updateTotals();
  }

  function addSelection() {
    if (mode !== 'idle') return;
    const product = chosenProduct();
    if (!product) return;
    const qty = Number(query('#sales-quantity').value);
    const grams = isUnit(product) ? 0 : Number(query('#sales-weight').value);
    const candidate = lines.map(line => ({ ...line }));
    const previous = candidate.find(line => line.id === product.id && line.sale_unit === product.sale_unit && line.weight_grams === grams);
    if (previous) previous.qty += qty;
    else candidate.push({ key: ++lineSequence, id: product.id, name: product.name, sale_unit: product.sale_unit, weight_grams: grams, qty });
    const result = analyze(candidate);
    if (result.errors.length) { notify(result.errors.join(' '), 'error'); return; }
    lines = candidate;
    pendingPayload = null;
    notify();
    renderLines();
  }

  function renderHistory() {
    query('#sales-history').innerHTML = recentSales.length ? recentSales.map(sale => {
      const rawDate = String(sale.created_at || '');
      const parsedDate = new Date(rawDate.includes('T') ? rawDate : `${rawDate.replace(' ', 'T')}Z`);
      const date = Number.isNaN(parsedDate.valueOf()) ? rawDate : parsedDate.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const profit = sale.profit;
      const cancellable = sale.status !== 'cancelado';
      return `<article class="sales-history-card"><div class="sales-history-top"><div><strong>Venda #${sale.id}</strong><small>${escapeHtml(date)}</small></div><span class="sales-status${sale.status === 'cancelado' ? ' is-cancelled' : ''}">${escapeHtml(statusNames[sale.status] || sale.status)}</span><b>${money(sale.total_cents)}</b></div><p class="sales-muted">${escapeHtml(paymentNames[sale.payment_method] || sale.payment_method || 'Pagamento não informado')}${sale.customer ? ` · ${escapeHtml(sale.customer)}` : ''}</p><details><summary>Ver itens da venda</summary><ul>${(sale.items || []).map(item => `<li><span>${escapeHtml(item.name)}<small>${item.qty} ${item.sale_unit === 'unit' ? (item.qty === 1 ? 'unidade' : 'unidades') : `${item.qty === 1 ? 'porção' : 'porções'} de ${formatWeight(item.weight_grams)}`}</small></span><b>${money(item.price_cents * item.qty)}</b></li>`).join('')}</ul>${sale.notes ? `<p class="sales-muted">${escapeHtml(sale.notes)}</p>` : ''}${profit?.profit_cents != null ? `<p class="sales-muted">Lucro estimado: ${money(profit.profit_cents)}${profit.margin_percent == null ? '' : ` · Margem: ${Number(profit.margin_percent).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`}<small>Antes de despesas e taxas.</small></p>` : '<p class="sales-muted">Lucro indisponível: há produtos sem custo cadastrado.</p>'}</details>${cancellable ? `<button type="button" class="sales-text-action" data-cancel-sale="${sale.id}">Cancelar venda</button>` : ''}</article>`;
    }).join('') : '<p class="sales-empty">Nenhuma venda presencial registrada ainda.</p>';
    for (const button of query('#sales-history').querySelectorAll('button')) button.disabled = mode !== 'idle';
  }

  async function loadSales() {
    if (!mount()) return;
    const session = captureAdminSession();
    const epoch = sessionEpoch;
    const sequence = ++loadSequence;
    const data = await api('/sales');
    assertAdminSession(session);
    if (epoch !== sessionEpoch || sequence !== loadSequence) return;
    catalog = data.products;
    recentSales = data.sales || [];
    maxWeight = data.max_weight_grams || PuroPricing.MAX_WEIGHT_GRAMS;
    const category = query('#sales-category').value;
    const categories = [...new Set(catalog.map(product => product.category))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    query('#sales-category').innerHTML = '<option value="">Todas as categorias</option>' + categories.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    query('#sales-category').value = category;
    productOptions();
    renderLines();
    renderHistory();
  }

  function requestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, character => (Number(character) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(character) / 4).toString(16));
  }

  async function refreshPanels() {
    return Promise.allSettled([
      loadSales(),
      typeof loadProducts === 'function' ? loadProducts() : Promise.resolve(),
      typeof loadOrders === 'function' ? loadOrders() : Promise.resolve(),
    ]);
  }

  async function registerSale(retry = false) {
    const session = captureAdminSession();
    if (!adminSessionIsCurrent(session)) return;
    if (retry ? mode !== 'uncertain' || !pendingPayload : mode !== 'idle') return;
    if (!retry) {
      const result = analyze();
      if (!lines.length || result.errors.length || !query('#sales-payment').value) {
        notify(result.errors.join(' ') || 'Adicione produtos e escolha a forma de pagamento.', 'error');
        return;
      }
      pendingPayload = {
        request_id: requestId(),
        items: lines.map(({ id, sale_unit, weight_grams, qty }) => ({ id, sale_unit, weight_grams, qty })),
        expected_total_cents: result.total,
        payment_method: query('#sales-payment').value,
        customer: query('#sales-customer').value.trim(),
        notes: query('#sales-notes').value.trim(),
      };
      pendingLineTotals = new Map(lines.map(line => [line.key, portionPrice(lineProduct(line), line.weight_grams) * line.qty]));
      // Save before sending: a page reload must retain the same idempotency key.
      savePending();
    }
    const payload = pendingPayload;
    const epoch = sessionEpoch;
    setMode('posting');
    notify(retry ? 'Verificando se esta venda já foi registrada…' : 'Registrando a venda…');
    let response;
    try {
      response = await api('/sales', 'POST', payload);
    } catch (error) {
      if (epoch !== sessionEpoch || !adminSessionIsCurrent(session)) return;
      if (!error.status || error.status >= 500) {
        setMode('uncertain');
        notify(uncertainMessage(), 'warning');
      } else {
        pendingPayload = null;
        pendingLineTotals.clear();
        clearPendingStorage();
        let refreshFailed = false;
        try { await loadSales(); } catch (_) { refreshFailed = true; }
        if (epoch !== sessionEpoch || !adminSessionIsCurrent(session)) return;
        setMode('idle');
        notify(`${error.message}${refreshFailed ? ' Não foi possível atualizar o catálogo; use Atualizar antes de tentar novamente.' : ' Revise os itens e o total antes de tentar novamente.'}`, 'error');
      }
      return;
    }
    if (epoch !== sessionEpoch || !adminSessionIsCurrent(session)) return;
    // Clear the confirmed sale before refreshing any other panel.
    lines = [];
    pendingPayload = null;
    pendingLineTotals.clear();
    clearPendingStorage();
    query('#sales-payment').value = '';
    query('#sales-customer').value = '';
    query('#sales-notes').value = '';
    renderLines();
    const success = response.deleted ? `Venda #${response.id} já havia sido registrada e foi excluída. Nenhuma nova venda foi criada.`
      : response.status === 'cancelado' ? `Venda #${response.id} já havia sido registrada e está cancelada. Nenhuma nova venda foi criada.`
      : `Venda #${response.id} ${response.duplicate ? 'já registrada; confirmação recuperada' : 'registrada como paga'}. Total: ${money(response.total_cents)}.`;
    notify(success, 'success');
    const results = await refreshPanels();
    if (epoch !== sessionEpoch || !adminSessionIsCurrent(session)) return;
    setMode('idle');
    if (results.some(result => result.status === 'rejected')) notify(`${success} Não foi possível atualizar todos os dados. Use Atualizar para consultar o histórico.`, 'warning');
    query('#sales-feedback').focus({ preventScroll: true });
  }

  async function cancelSale(id) {
    const session = captureAdminSession();
    if (!adminSessionIsCurrent(session)) return;
    if (mode !== 'idle') return;
    if (!confirm(`Cancelar a venda #${id}? Os produtos serão devolvidos ao estoque e a venda deixará de contar no faturamento.`)) return;
    const epoch = sessionEpoch;
    setMode('cancelling');
    notify('Cancelando venda…');
    try {
      await api(`/orders/${id}`, 'PATCH', { status: 'cancelado' });
      if (epoch !== sessionEpoch || !adminSessionIsCurrent(session)) return;
      notify(`Venda #${id} cancelada. Estoque devolvido.`, 'success');
      const results = await refreshPanels();
      if (epoch !== sessionEpoch || !adminSessionIsCurrent(session)) return;
      if (results.some(result => result.status === 'rejected')) notify(`Venda #${id} cancelada. Use Atualizar para consultar os dados mais recentes.`, 'warning');
    } catch (error) {
      if (epoch !== sessionEpoch || !adminSessionIsCurrent(session)) return;
      notify(`${error.message} Atualize o histórico para verificar o status da venda.`, 'error');
    } finally {
      if (epoch === sessionEpoch && adminSessionIsCurrent(session)) setMode('idle');
    }
  }

  async function refreshManually() {
    const session = captureAdminSession();
    if (!adminSessionIsCurrent(session)) return;
    if (mode !== 'idle') return;
    const epoch = sessionEpoch;
    setMode('refreshing');
    try { await loadSales(); if (epoch === sessionEpoch && adminSessionIsCurrent(session)) notify('Produtos e vendas atualizados.', 'success'); }
    catch (error) { if (epoch === sessionEpoch && adminSessionIsCurrent(session) && !ignoreAdminError(error)) notify(error.message, 'error'); }
    finally { if (epoch === sessionEpoch && adminSessionIsCurrent(session)) setMode('idle'); }
  }

  function handleClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.id === 'sales-retry') { registerSale(true); return; }
    if (mode !== 'idle') return;
    if (button.dataset.salesProduct) {
      selectProduct(button.dataset.salesProduct);
      query(chosenProduct() && !isUnit(chosenProduct()) ? '#sales-weight' : '#sales-quantity').focus();
    } else if (button.id === 'sales-add') addSelection();
    else if (button.id === 'sales-clear') {
      if (!lines.length || !confirm('Remover todos os itens desta venda?')) return;
      lines = []; pendingPayload = null; notify(); renderLines();
    } else if (button.id === 'sales-refresh') refreshManually();
    else if (button.dataset.removeLine) {
      lines = lines.filter(line => line.key !== Number(button.dataset.removeLine));
      pendingPayload = null; notify(); renderLines();
    } else if (button.dataset.salesStep) {
      const field = query('#sales-quantity');
      field.value = Math.max(1, Math.min(99, (Number(field.value) || 1) + Number(button.dataset.salesStep)));
      updateSelection();
    } else if (button.dataset.salesWeight) {
      query('#sales-weight').value = button.dataset.salesWeight;
      updateSelection();
    } else if (button.dataset.cancelSale) cancelSale(Number(button.dataset.cancelSale));
  }

  function handleInput(event) {
    if (mode !== 'idle') return;
    if (event.target.id === 'sales-search') productOptions();
    else if (event.target.matches('#sales-quantity, #sales-weight')) updateSelection();
    else if (event.target.dataset.lineField) {
      const line = lines.find(item => item.key === Number(event.target.closest('[data-sales-line]').dataset.salesLine));
      if (!line) return;
      line[event.target.dataset.lineField] = Number(event.target.value);
      pendingPayload = null;
      updateTotals();
    }
  }

  function handleChange(event) {
    if (mode !== 'idle') return;
    if (event.target.id === 'sales-category') productOptions();
    else if (event.target.id === 'sales-product-select') {
      selectProduct(event.target.value);
    } else if (event.target.id === 'sales-payment') updateTotals();
  }

  function clearSalesSession() {
    sessionEpoch++;
    loadSequence++;
    catalog = []; recentSales = []; lines = []; pendingPayload = null; pendingLineTotals.clear(); mode = 'idle';
    clearPendingStorage();
    if (!mounted) return;
    for (const selector of ['#sales-search', '#sales-customer', '#sales-notes', '#sales-payment', '#sales-category']) query(selector).value = '';
    query('#sales-category').innerHTML = '<option value="">Todas as categorias</option>';
    query('#sales-quantity').value = 1;
    query('#sales-weight').value = 100;
    productOptions(); renderLines(); renderHistory(); setMode('idle'); notify();
  }

  root.loadSales = loadSales;
  root.clearSalesSession = clearSalesSession;
})(globalThis);
