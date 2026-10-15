const formatMargin = value => value == null ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

function productFinance(product) {
  if (product.cost_cents == null) return '<span class="finance-muted">Custo não informado</span>';
  const basis = isUnit(product) ? 'unidade' : 'kg';
  const sale = portionPrice(product, 1000);
  const profit = sale - product.cost_cents;
  return `${formatBrl(product.cost_cents / 100)} / ${basis}<small class="finance-detail ${profit < 0 ? 'finance-loss' : ''}">Margem ${formatMargin(PuroProfitability.marginPercent(sale, product.cost_cents))}<br>Lucro ${formatBrl(profit / 100)} / ${basis}</small>`;
}

function updateCostPreview() {
  const price = parsePrice($('#pprice').value);
  const costText = $('#pcost').value.trim();
  const cost = costText ? parsePrice(costText) : null;
  const unit = $('#psale-unit').value === 'unit';
  const grams = Number($('#pweight').value);
  const preview = $('#product-profit-preview');
  if (!Number.isFinite(price) || price < 0 || price > 10000000 || (!unit && (!Number.isInteger(grams) || grams < 1 || grams > MAX_WEIGHT_GRAMS))) {
    preview.textContent = 'Informe preço e medida para conferir custo, lucro e margem.';
    return;
  }
  if (cost !== null && (!Number.isFinite(cost) || cost < 0 || cost > 10000000)) {
    preview.textContent = 'Informe um custo válido ou deixe o campo vazio.';
    return;
  }
  const product = { sale_unit: unit ? 'unit' : 'weight', price_cents: Math.round(price * 100), price_weight_grams: grams };
  const sale = portionPrice(product, 1000);
  const cents = cost === null ? null : Math.round(cost * 100);
  const basis = unit ? 'unidade' : 'kg';
  preview.innerHTML = `<div><span>Venda por ${basis}</span><strong>${formatBrl(sale / 100)}</strong></div><div><span>Custo por ${basis}</span><strong>${cents === null ? 'Não informado' : formatBrl(cents / 100)}</strong></div><div><span>Lucro estimado por ${basis}</span><strong class="${cents !== null && sale < cents ? 'finance-loss' : ''}">${cents === null ? '—' : formatBrl((sale - cents) / 100)}</strong></div><div><span>Margem bruta</span><strong>${formatMargin(PuroProfitability.marginPercent(sale, cents))}</strong></div><small class="full-width">Lucro = venda − custo. Margem = lucro ÷ venda. Estimativa antes de despesas, taxas e frete.</small>`;
  if (!unit && $('#ppromo').checked) {
    const discounted = portionPrice({ ...product, discount_percent: 20 }, 1000);
    preview.innerHTML += `<small class="full-width">Na Terça do Granel: venda ${formatBrl(discounted / 100)} / kg${cents === null ? '' : ` · lucro ${formatBrl((discounted - cents) / 100)} / kg · margem ${formatMargin(PuroProfitability.marginPercent(discounted, cents))}`}.</small>`;
  }
}

for (const selector of ['#pprice', '#pweight', '#pcost', '#ppromo']) {
  $(selector).addEventListener('input', updateCostPreview);
}
updateCostPreview();
