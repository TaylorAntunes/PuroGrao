const DEFAULT_BANNER = { active: false, title: '', description: '', link_label: '', link_url: '' };

function validBannerLink(value) {
  if (!value) return true;
  if (value.startsWith('//') || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const base = 'https://puro-grao.local';
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    return /^https?:\/\//i.test(value) || (url.origin === base && (value.startsWith('/') || value.startsWith('#')));
  } catch (_) { return false; }
}

function cleanBanner(body = {}) {
  const invalid = () => { throw Object.assign(new Error('Confira os textos e o link do banner. Use um endereço http/https, /ofertas ou #produtos.'), { status: 400 }); };
  if (!body || typeof body !== 'object' || typeof body.active !== 'boolean') invalid();
  const banner = { active: body.active };
  for (const [key, maximum] of Object.entries({ title: 100, description: 300, link_label: 40, link_url: 500 })) {
    if (typeof body[key] !== 'string' || body[key].length > maximum) invalid();
    banner[key] = body[key].trim();
  }
  if ((banner.active && !banner.title) || Boolean(banner.link_label) !== Boolean(banner.link_url) || !validBannerLink(banner.link_url)) invalid();
  return banner;
}

function readBanner(db) {
  const row = db.prepare('SELECT active, title, description, link_label, link_url FROM site_banner WHERE id=1').get();
  return row ? { ...row, active: Boolean(row.active) } : { ...DEFAULT_BANNER };
}

module.exports = { cleanBanner, readBanner };
