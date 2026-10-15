// Read-only sales history; orders keep their existing status and inventory rules.
(function (root) {
  const pageSize = 25;
  const query = selector => document.querySelector(selector);
  const money = cents => formatBrl(Number(cents) / 100);
  const number = value => Number(value).toLocaleString('pt-BR');
  const statuses = { novo: 'Novo', confirmado: 'Confirmado', pago: 'Pago', entregue: 'Entregue', cancelado: 'Cancelado' };
  const paymentNames = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', outro: 'Outro' };
  let mounted = false;
  let offset = 0;
  let total = 0;
  let sequence = 0;
  let sessionEpoch = 0;
  let searchTimer;
  let loading = false;

  function mount() {
    const workspace = query('#sales-history-workspace');
    if (mounted || !workspace) return Boolean(workspace);
    workspace.innerHTML = `
      <div class="history-heading"><p class="form-help">Pedidos feitos pelo site aparecem aqui automaticamente. O faturamento considera somente pedidos pagos ou entregues.</p><button id="sales-history-refresh" type="button">Atualizar</button></div>
      <section class="history-metrics" aria-label="Indicadores do histórico filtrado">
        <article><span>Registros</span><strong id="sales-history-count">—</strong><small>Todos os status selecionados</small></article>
        <article><span>Faturamento confirmado</span><strong id="sales-history-revenue">—</strong><small id="sales-history-paid-count">Pedidos pagos ou entregues</small></article>
        <article><span>Ticket médio</span><strong id="sales-history-ticket">—</strong><small>Entre pedidos pagos ou entregues</small></article>
        <article><span>Pendentes</span><strong id="sales-history-pending">—</strong><small id="sales-history-cancelled-count">Novos e confirmados</small></article>
      </section>
      <p class="history-metrics-help">Os indicadores consideram os filtros selecionados e todas as páginas do histórico.</p>
      <form id="sales-history-filters" class="history-filters" aria-label="Filtros de vendas">
        <label class="history-search-field" for="sales-history-search">Buscar pedido<input id="sales-history-search" type="search" maxlength="120" autocomplete="off" placeholder="Nome do cliente, número do pedido ou telefone"></label>
        <label for="sales-history-channel">Origem<select id="sales-history-channel"><option value="whatsapp">Site</option><option value="all">Todas as origens</option><option value="in_person">Presencial</option></select></label>
        <label for="sales-history-status">Status<select id="sales-history-status"><option value="all">Todos os status</option>${Object.entries(statuses).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
        <label for="sales-history-from">A partir de<input id="sales-history-from" type="date"></label>
        <label for="sales-history-to">Até<input id="sales-history-to" type="date"></label>
        <div class="history-filter-actions"><button id="sales-history-clear" type="button">Limpar filtros</button></div>
      </form>
      <div id="sales-history-feedback" class="history-feedback" role="alert"></div>
      <div class="history-list-heading"><h3>Pedidos registrados</h3><button id="sales-history-manage" type="button">Gerenciar pedidos ${adminIcon('arrow')}</button></div>
      <p id="sales-history-loading" class="history-empty" role="status" hidden>Carregando histórico…</p>
      <p id="sales-history-empty" class="history-empty" role="status" hidden>Nenhum pedido encontrado para os filtros selecionados.</p>
      <div id="sales-history-records" class="history-records" aria-busy="false"></div>
      <nav class="history-pagination" aria-label="Páginas do histórico de vendas"><button id="sales-history-prev" type="button" disabled>Anterior</button><span id="sales-history-page" role="status" aria-live="polite">0 registros</span><button id="sales-history-next" type="button" disabled>Próxima</button></nav>
      <p class="history-timezone">Datas exibidas no horário de São Paulo.</p>`;
    mounted = true;
    workspace.addEventListener('input', event => {
      if (event.target.id !== 'sales-history-search') return;
      offset = 0;
      sequence++;
      clearTimeout(searchTimer);
      setLoading(true);
      searchTimer = setTimeout(() => loadSalesHistory(), 300);
    });
    workspace.addEventListener('change', event => {
      if (!event.target.matches('#sales-history-channel, #sales-history-status, #sales-history-from, #sales-history-to')) return;
      offset = 0;
      loadSalesHistory();
    });
    workspace.addEventListener('click', handleClick);
    query('#sales-history-filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; loadSalesHistory(); });
    return true;
  }

  function feedback(message = '') {
    query('#sales-history-feedback').textContent = message;
  }

  function resetMetrics() {
    for (const id of ['count', 'revenue', 'ticket', 'pending']) query(`#sales-history-${id}`).textContent = '—';
    query('#sales-history-paid-count').textContent = 'Pedidos pagos ou entregues';
    query('#sales-history-cancelled-count').textContent = 'Novos e confirmados';
  }

  function setLoading(value) {
    loading = value;
    query('#sales-history-workspace').classList.toggle('is-loading', value);
    query('#sales-history-records').setAttribute('aria-busy', String(value));
    query('#sales-history-loading').hidden = !value;
    query('#sales-history-refresh').disabled = value;
    query('#sales-history-prev').disabled = value || offset === 0 || total === 0;
    query('#sales-history-next').disabled = value || offset + pageSize >= total;
    if (value) {
      resetMetrics();
      query('#sales-history-records').hidden = true;
      query('#sales-history-empty').hidden = true;
      query('#sales-history-page').textContent = 'Carregando…';
      feedback();
    }
  }

  function dateLabel(value) {
    const text = String(value || '').trim().replace(' ', 'T');
    const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
    const date = new Date(iso);
    return Number.isNaN(date.valueOf()) ? 'Data não informada' : date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }

  function itemAmount(item) {
    const count = Number(item.qty);
    if (item.sale_unit === 'unit') return `${number(count)} ${count === 1 ? 'unidade' : 'unidades'}`;
    return `${number(count)} ${count === 1 ? 'porção' : 'porções'} · ${item.weight_grams > 0 ? `${formatWeight(item.weight_grams)} cada` : 'peso não registrado'}`;
  }

  function profitMarkup(order) {
    if (!order.profit) return '<p class="history-profit-help">Lucro indisponível: custos incompletos neste registro.</p>';
    const profit = order.profit;
    return `<dl class="history-finance"><div><dt>Custo registrado</dt><dd>${money(profit.cost_cents)}</dd></div><div><dt>Lucro bruto estimado</dt><dd${profit.profit_cents < 0 ? ' class="history-loss"' : ''}>${money(profit.profit_cents)}</dd></div><div><dt>Margem</dt><dd>${profit.margin_percent == null ? '—' : `${Number(profit.margin_percent).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`}</dd></div></dl><p class="history-profit-help">Valores registrados na venda, antes de despesas e taxas.${order.status === 'cancelado' ? ' Pedido cancelado: fora do faturamento e do lucro do período.' : !['pago', 'entregue'].includes(order.status) ? ' Pedido pendente: ainda fora do faturamento confirmado.' : ''}</p>`;
  }

  function renderOrders(orders) {
    const previouslyOpen = new Set([...query('#sales-history-records').querySelectorAll('details[open]')].map(node => node.dataset.historyOrder));
    query('#sales-history-records').innerHTML = orders.map(order => {
      const channel = order.sales_channel === 'in_person' ? 'Presencial' : 'Site';
      const paid = ['pago', 'entregue'].includes(order.status);
      const statusClass = order.status === 'cancelado' ? 'is-cancelled' : paid ? 'is-paid' : 'is-pending';
      const items = Array.isArray(order.items) ? order.items : [];
      const delivery = order.sales_channel === 'in_person' ? `Venda na loja${order.payment_method ? ` · ${paymentNames[order.payment_method] || order.payment_method}` : ''}` : order.delivery_method === 'delivery' ? `Entrega${order.delivery_city ? ` · ${order.delivery_city}` : ''}${order.free_shipping ? ' · Frete grátis' : ''}` : 'Retirada na loja';
      return `<article class="history-order"><div class="history-order-top"><div><strong>Pedido #${escapeHtml(order.id)}</strong><span class="history-channel">${channel}</span><small>${escapeHtml(dateLabel(order.created_at))}</small></div><span class="history-status ${statusClass}">${escapeHtml(statuses[order.status] || order.status || 'Não informado')}</span><b>${money(order.total_cents)}</b></div><p class="history-customer">${escapeHtml(order.customer || 'Cliente não informado')}${order.phone ? `<small>${escapeHtml(order.phone)}</small>` : ''}</p><details data-history-order="${escapeHtml(order.id)}"${previouslyOpen.has(String(order.id)) ? ' open' : ''}><summary>Ver detalhes do pedido</summary>${items.length ? `<ul class="history-items">${items.map(item => `<li><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(itemAmount(item))}</small></span><b>${money(item.price_cents * item.qty)}</b></li>`).join('')}</ul>` : '<p class="history-profit-help">Este registro não tem itens disponíveis.</p>'}<div class="history-delivery"><p>${escapeHtml(delivery)}</p>${order.address ? `<p><strong>Endereço:</strong> ${escapeHtml(order.address)}</p>` : ''}${order.notes ? `<p><strong>Observações:</strong> ${escapeHtml(order.notes)}</p>` : ''}</div>${profitMarkup(order)}</details></article>`;
    }).join('');
    query('#sales-history-records').hidden = !orders.length;
    query('#sales-history-empty').hidden = orders.length > 0;
  }

  function render(data) {
    offset = data.offset;
    total = data.total;
    const summary = data.summary;
    query('#sales-history-count').textContent = number(summary.orders);
    query('#sales-history-revenue').textContent = money(summary.sales_cents);
    query('#sales-history-ticket').textContent = money(summary.average_ticket_cents);
    query('#sales-history-pending').textContent = number(summary.pending_orders);
    query('#sales-history-paid-count').textContent = `${number(summary.sales_orders)} ${summary.sales_orders === 1 ? 'pedido pago ou entregue' : 'pedidos pagos ou entregues'}`;
    query('#sales-history-cancelled-count').textContent = `${number(summary.cancelled_orders)} ${summary.cancelled_orders === 1 ? 'cancelado no filtro' : 'cancelados no filtro'}`;
    renderOrders(data.orders);
    query('#sales-history-page').textContent = total ? `${number(offset + 1)}–${number(offset + data.orders.length)} de ${number(total)} registros` : '0 registros';
  }

  async function loadSalesHistory() {
    if (!mount()) return;
    const session = captureAdminSession();
    if (!adminSessionIsCurrent(session)) return;
    clearTimeout(searchTimer);
    const epoch = sessionEpoch;
    const currentSequence = ++sequence;
    const search = query('#sales-history-search').value.trim();
    const channel = query('#sales-history-channel').value;
    const status = query('#sales-history-status').value;
    const from = query('#sales-history-from').value;
    const to = query('#sales-history-to').value;
    setLoading(true);
    if (from && to && from > to) {
      query('#sales-history-records').innerHTML = '';
      total = 0;
      setLoading(false);
      query('#sales-history-page').textContent = 'Confira o período';
      feedback('A data inicial deve ser anterior ou igual à data final.');
      return;
    }
    try {
      let data;
      do {
        const params = new URLSearchParams({ channel, status, offset, limit: pageSize });
        if (search) params.set('search', search);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        data = await api(`/sales-history?${params}`);
        assertAdminSession(session);
        if (epoch !== sessionEpoch || currentSequence !== sequence) return;
        // A deletion or status edit elsewhere may shrink the filtered result set.
        if (offset > 0 && offset >= data.total) {
          offset = data.total ? Math.floor((data.total - 1) / pageSize) * pageSize : 0;
          continue;
        }
        break;
      } while (true);
      render(data);
    } catch (error) {
      if (epoch !== sessionEpoch || currentSequence !== sequence || !adminSessionIsCurrent(session) || ignoreAdminError(error)) return;
      total = 0;
      query('#sales-history-records').innerHTML = '';
      query('#sales-history-records').hidden = true;
      query('#sales-history-empty').hidden = true;
      query('#sales-history-page').textContent = 'Histórico indisponível';
      feedback(error.message || 'Não foi possível carregar o histórico. Tente Atualizar.');
    } finally {
      if (epoch === sessionEpoch && currentSequence === sequence && adminSessionIsCurrent(session)) setLoading(false);
    }
  }

  function resetFilters() {
    query('#sales-history-search').value = '';
    query('#sales-history-channel').value = 'whatsapp';
    query('#sales-history-status').value = 'all';
    query('#sales-history-from').value = '';
    query('#sales-history-to').value = '';
    offset = 0;
  }

  function handleClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.id === 'sales-history-clear') {
      resetFilters();
      query('#sales-history-search').focus();
      loadSalesHistory();
    } else if (button.id === 'sales-history-refresh') loadSalesHistory();
    else if (button.id === 'sales-history-prev' && !loading) {
      offset = Math.max(0, offset - pageSize);
      loadSalesHistory();
    } else if (button.id === 'sales-history-next' && !loading) {
      offset += pageSize;
      loadSalesHistory();
    } else if (button.id === 'sales-history-manage') query('.tabs [data-t="or"]')?.click();
  }

  function clearSalesHistorySession() {
    sessionEpoch++;
    sequence++;
    clearTimeout(searchTimer);
    offset = total = 0;
    loading = false;
    if (!mounted) return;
    resetFilters();
    query('#sales-history-records').innerHTML = '';
    query('#sales-history-records').hidden = true;
    query('#sales-history-empty').hidden = true;
    resetMetrics();
    feedback();
    setLoading(false);
    query('#sales-history-page').textContent = '0 registros';
  }

  root.loadSalesHistory = loadSalesHistory;
  root.clearSalesHistorySession = clearSalesHistorySession;
})(globalThis);
