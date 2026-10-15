async function loadDashboard() {
  const session = captureAdminSession();
  const data = await api('/dashboard');
  assertAdminSession(session);
  $('#sales-day').textContent = formatBrl(data.day.sales_cents / 100);
  $('#sales-month').textContent = formatBrl(data.month.sales_cents / 100);
  const salesCount = number => `${number} ${number === 1 ? 'pedido pago ou entregue' : 'pedidos pagos ou entregues'}`;
  $('#sales-day-orders').textContent = salesCount(data.day.sales_orders);
  $('#sales-month-orders').textContent = salesCount(data.month.sales_orders);
  $('#average-ticket').textContent = formatBrl(data.month.average_ticket_cents / 100);
  $('#orders-day').textContent = data.day.orders;
  $('#orders-month').textContent = data.month.orders;
  const detail = period => `${period.pending_orders} ${period.pending_orders === 1 ? 'pendente' : 'pendentes'} · ${period.cancelled_orders} ${period.cancelled_orders === 1 ? 'cancelado' : 'cancelados'}`;
  $('#orders-day-detail').textContent = detail(data.day);
  $('#orders-month-detail').textContent = detail(data.month);
  $('#stock-count').textContent = data.stock.low_stock;
  $('#stock-count-detail').textContent = `${data.stock.sold_out} ${data.stock.sold_out === 1 ? 'esgotado' : 'esgotados'} · até 3 kg ou 3 unidades, incluindo ocultos`;
  for (const period of ['day', 'month']) {
    const profit = data.profit[period];
    $(`#profit-${period}`).textContent = profit.profit_cents == null ? '—' : formatBrl(profit.profit_cents / 100);
    $(`#profit-${period}`).classList.toggle('finance-loss', profit.profit_cents < 0);
    $(`#profit-${period}-detail`).textContent = `${profit.known_orders} ${profit.known_orders === 1 ? 'pedido com custo completo' : 'pedidos com custo completo'}${profit.unknown_orders ? ` · ${profit.unknown_orders} sem custo completo (fora do cálculo)` : ''}`;
  }
  $('#profit-margin').textContent = formatMargin(data.profit.month.margin_percent);
  $('#dashboard-updated').textContent = `Atualizado em ${new Date(data.updated_at).toLocaleString('pt-BR', { timeZone: data.timezone })} · horário de São Paulo`;
  $('#dashboard-sellers-empty').hidden = data.best_sellers.length > 0;
  const maximum = Math.max(1, ...data.best_sellers.map(product => product.orders));
  $('#dashboard-sellers').innerHTML = data.best_sellers.map(product => `<li><div class="seller-summary"><strong>${escapeHtml(product.name)}</strong><span>${product.orders} ${product.orders === 1 ? 'pedido' : 'pedidos'}${product.units ? ` · ${formatUnits(product.units)}` : ''}${product.weight_portions ? ` · ${product.weight_portions} ${product.weight_portions === 1 ? 'porção' : 'porções'}` : ''}${product.weight_grams ? ` · ${formatWeight(product.weight_grams)}` : ''}</span><b>${formatBrl(product.sales_cents / 100)}</b></div><div class="seller-track" aria-hidden="true"><span style="width:${product.orders / maximum * 100}%"></span></div></li>`).join('');
}

function clearDashboardSession() {
  for (const id of ['sales-day', 'sales-month', 'average-ticket', 'orders-day', 'orders-month', 'stock-count', 'profit-day', 'profit-month', 'profit-margin']) {
    $(`#${id}`).textContent = '—';
    $(`#${id}`).classList.remove('finance-loss');
  }
  for (const id of ['sales-day-orders', 'sales-month-orders', 'orders-day-detail', 'orders-month-detail', 'stock-count-detail', 'profit-day-detail', 'profit-month-detail', 'dashboard-updated']) $(`#${id}`).textContent = '';
  $('#dashboard-sellers').innerHTML = '';
  $('#dashboard-sellers-empty').hidden = true;
}

$('#refresh-dashboard').onclick = async () => {
  const session = captureAdminSession();
  $('#refresh-dashboard').disabled = true;
  $('#aerr').textContent = '';
  try { await loadProducts(); } catch (error) { showError(error); }
  finally { if (adminSessionIsCurrent(session)) $('#refresh-dashboard').disabled = false; }
};
setInterval(() => {
  if (token && !$('#db').hidden && document.visibilityState === 'visible') loadProducts().catch(showError);
}, 60000);

