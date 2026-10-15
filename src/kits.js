const { MAX_WEIGHT_GRAMS } = require('./pricing');

function cleanKit(body, db) {
  const name = String(body?.name || '').trim().slice(0, 80);
  const description = String(body?.description || '').trim().slice(0, 300);
  const components = body?.components;
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (typeof body?.name !== 'string' || (body.description !== undefined && typeof body.description !== 'string')) fail('Informe o nome e a descrição do kit como textos.');
  if (!name || !Array.isArray(components) || !components.length || components.length > 20) fail('Informe o nome e de 1 a 20 produtos para o kit.');
  if (body.active !== undefined && typeof body.active !== 'boolean') fail('Informe se o kit está visível.');
  const ids = new Set();
  const find = db.prepare('SELECT id, sale_unit FROM products WHERE id = ?');
  const cleaned = [];
  for (const item of components) {
    if (!item || !Number.isSafeInteger(item.id) || !find.get(item.id) || ids.has(item.id)) fail('Escolha produtos existentes, sem repetir o mesmo produto no kit.');
    const product = find.get(item.id);
    const unit = product.sale_unit === 'unit';
    if (item.sale_unit !== undefined && item.sale_unit !== product.sale_unit) fail('A forma de venda do produto mudou. Confira a composição do kit.');
    if ((unit ? item.weight_grams !== undefined && item.weight_grams !== 0 : !Number.isInteger(item.weight_grams) || item.weight_grams < 1 || item.weight_grams > MAX_WEIGHT_GRAMS) || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > 99) fail('Informe pesos inteiros de 1 a 100.000 g e quantidades de 1 a 99. Produtos por unidade não recebem peso.');
    ids.add(item.id);
    cleaned.push(unit ? { id: item.id, sale_unit: 'unit', weight_grams: 0, qty: item.qty } : { id: item.id, weight_grams: item.weight_grams, qty: item.qty });
  }
  return { name, description, active: body.active === false ? 0 : 1, components: JSON.stringify(cleaned) };
}

module.exports = { cleanKit };
