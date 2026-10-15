const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real browser modules with an isolated DOM and controllable network.
// No application/server/database module is loaded by these tests.
function panel() {
  const nodes = new Map();
  const requests = [];
  const revoked = [];
  const alerts = [];
  const imageReaders = [];
  const storage = new Map([['t', 'fixture-session-a']]);
  const defaults = { 'psale-unit': 'weight', pweight: '1000', pcolor: '#B98A4B',
    'pimage-x': '50', 'pimage-y': '50', 'pimage-fit': 'cover', 'movement-reason': 'purchase', 'movement-direction': 'in' };
  const formFields = {
    '#pf': ['pid', 'pname', 'pprice', 'pcost', 'pstock', 'psale-unit', 'pweight', 'pcat', 'pcat-new', 'pdesc', 'pcolor', 'pactive', 'ppromo', 'pnew', 'pimage', 'pimage-x', 'pimage-y', 'pimage-fit'],
    '#kit-form': ['kit-id', 'kit-name', 'kit-description', 'kit-active'],
    '#banner-form': ['banner-active', 'banner-title', 'banner-description', 'banner-link-label', 'banner-link-url'],
    '#stock-movement-form': ['movement-product', 'movement-reason', 'movement-direction', 'movement-quantity', 'movement-note'],
  };
  let elementId = 0;
  class Element {
    constructor(selector) {
      this.selector = selector;
      this.id = selector.slice(1);
      this.value = defaults[this.id] || '';
      this.hidden = ['login', 'pr', 'or', 'kt', 'bn', 'st', 'ps', 'sh'].includes(this.id);
      this.disabled = false;
      this.checked = false;
      this.style = {};
      this.dataset = {};
      this.children = [];
      this.files = [];
      this.attributes = new Map();
      this.listeners = new Map();
      this.classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
        toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      };
    }
    set innerHTML(value) { this.html = String(value); this.children = []; }
    get innerHTML() { return this.html || ''; }
    set textContent(value) { this.innerHTML = value; }
    get textContent() { return this.innerHTML; }
    set value(value) { this.inputValue = String(value); }
    get value() { return this.inputValue || ''; }
    set src(value) { this.attributes.set('src', value); }
    get src() { return this.attributes.get('src') || ''; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    append(node) { this.children.push(node); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    reset() {
      for (const id of formFields[this.selector] || []) {
        get(`#${id}`).value = defaults[id] || '';
        get(`#${id}`).checked = false;
      }
    }
    querySelector(selector) { return get(`${this.selector}|${selector}`); }
    querySelectorAll() { return []; }
  }
  function get(selector) {
    if (!nodes.has(selector)) nodes.set(selector, new Element(selector));
    return nodes.get(selector);
  }
  const tabs = ['db', 'pr', 'or', 'kt', 'bn', 'st', 'ps', 'sh'].map(id => {
    const tab = get(`tab-${id}`); tab.dataset.t = id; return tab;
  });
  const document = {
    activeElement: null,
    visibilityState: 'visible',
    querySelector: get,
    querySelectorAll(selector) {
      if (selector === '.tabs button') return tabs;
      if (selector === '#app form') return Object.keys(formFields).map(get);
      if (selector.startsWith('#app input')) return [...nodes.values()];
      if (selector === '.kit-component') return get('#kit-components').children;
      if (selector === '.kit-component select') return get('#kit-components').children.map(row => row.querySelector('select'));
      return [];
    },
    createElement: () => new Element(`element-${++elementId}`),
    addEventListener() {},
  };
  class FileReader {
    constructor() { imageReaders.push(this); }
    readAsDataURL(file) { this.file = file; }
    abort() { this.aborted = true; this.onabort?.(); }
  }
  const context = vm.createContext({
    document,
    PuroPricing: require('../shared/pricing'),
    PuroProfitability: require('../shared/profitability'),
    URLSearchParams,
    URL: { createObjectURL: () => 'blob:isolated-image', revokeObjectURL: url => revoked.push(url) },
    FileReader,
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: (url, options) => url === '/api/admin/logout'
      ? Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      : new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    alert: text => alerts.push(text),
    confirm: () => true,
    setInterval: () => 1,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
  });
  const run = code => vm.runInContext(code, context);
  for (const filename of ['admin.js', 'admin-finance.js', 'admin-inventory.js', 'admin-dashboard.js', 'admin-banner.js', 'admin-kits.js', 'admin-sales.js', 'admin-sales-history.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', filename), 'utf8');
    vm.runInContext(source, context, { filename });
  }
  return { context, run, get, nodes, requests, revoked, storage, imageReaders, alerts,
    respond(index, data, status = 200) { requests[index].resolve({ status, ok: status >= 200 && status < 300, json: async () => data }); } };
}

const stale = error => error.code === 'ADMIN_SESSION_STALE' && error.silent === true;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('logout clears private DOM, forms, arrays, pending storage and photo resources', async () => {
  const view = panel();
  const marker = 'PRIVATE_FIXTURE_MARKER';
  view.run(`products=[{name:'${marker}'}];productOrderBusy=true;adminKits=[{name:'${marker}'}];stockDrafts={weight:9000,unit:12};costDrafts={weight:'88',unit:'99'};`);
  for (const id of ['olist', 'plist', 'dashboard-sellers', 'low-stock-bars', 'stock-history-rows', 'kit-list', 'product-profit-preview', 'product-order-feedback']) view.get(`#${id}`).innerHTML = marker;
  for (const id of ['pname', 'pdesc', 'pprice', 'pcost', 'pstock', 'product-filter-search', 'movement-note', 'kit-name', 'kit-description', 'banner-title', 'banner-description', 'banner-link-label', 'banner-link-url', 'pw']) view.get(`#${id}`).value = marker;
  view.get('#sales-day').textContent = marker;
  view.storage.set('puro-grao-admin-pending-sale', marker);
  view.get('#pimage').files = [{ type: 'image/png', size: 20 }];
  view.get('#pimage').onchange();
  const reading = view.run("readImage({type:'image/png',size:20})");
  const rejection = assert.rejects(reading, stale);
  view.context.logout();
  await rejection;
  assert.equal(view.run('token'), '');
  assert.equal(view.get('#app').hidden, true);
  assert.equal(view.get('#login').hidden, false);
  assert.equal(view.get('#login button').disabled, false);
  assert.equal(view.storage.has('t'), false);
  assert.equal(view.storage.has('puro-grao-admin-pending-sale'), false);
  assert.equal(view.run('products.length+adminKits.length+activeImageReaders.size'), 0);
  assert.equal(view.run('productOrderBusy'), false);
  assert.equal(view.run('selectedImageFile'), null);
  assert.equal(view.run('previewObjectUrl+currentImageUrl'), '');
  assert.equal(view.run('stockDrafts.weight+stockDrafts.unit'), 0);
  assert.equal(view.run('costDrafts.weight+costDrafts.unit'), '');
  assert.equal(view.get('#pimage-preview').getAttribute('src'), null);
  assert.equal(view.get('#pimage-box').hidden, true);
  assert.deepEqual(view.revoked, ['blob:isolated-image']);
  assert.equal(view.imageReaders[0].aborted, true);
  assert.ok([...view.nodes.values()].every(node => !node.value.includes(marker) && !node.innerHTML.includes(marker)), 'Private values must be removed, not merely hidden');
  assert.deepEqual(view.alerts, []);
});

test('every administrative loader rejects stale data even at the consumer await boundary', async t => {
  for (const loader of ['loadProducts', 'loadOrders', 'loadDashboard', 'loadBanner', 'loadInventory', 'loadKits', 'loadSales', 'loadSalesHistory']) {
    await t.test(loader, async () => {
      const view = panel();
      let resolve;
      // A successful API promise can settle before its caller resumes; the caller
      // must check ownership too, rather than relying only on fetch validation.
      view.context.api = () => new Promise(done => { resolve = done; });
      const loading = Promise.resolve(view.context[loader]()).catch(error => { assert.ok(stale(error)); });
      view.context.logout();
      view.run("token='fixture-session-b';adminSessionEpoch++;");
      resolve({ orders: [{ customer: 'OLD_PRIVATE_ORDER' }], products: [{ name: 'OLD_PRIVATE_PRODUCT' }], kits: [{ name: 'OLD_PRIVATE_KIT' }], banner: { title: 'OLD_PRIVATE_BANNER' } });
      await loading;
      assert.equal(view.run('token'), 'fixture-session-b');
      assert.ok([...view.nodes.values()].every(node => !node.innerHTML.includes('OLD_PRIVATE_') && !node.value.includes('OLD_PRIVATE_')));
      assert.equal(view.get('#aerr').textContent, '');
    });
  }
});

test('late fetch, late JSON, old HTTP errors and old network failures cannot affect a new session', async t => {
  for (const kind of ['success', 'unauthorized', 'http-error', 'network-error', 'json']) {
    await t.test(kind, async () => {
      const view = panel();
      const loading = view.context.loadOrders();
      const rejection = assert.rejects(loading, stale);
      let resolveJson;
      if (kind === 'json') {
        view.requests[0].resolve({ status: 200, ok: true, json: () => new Promise(resolve => { resolveJson = resolve; }) });
        await tick();
        assert.equal(typeof resolveJson, 'function');
      }
      view.context.logout();
      view.run("token='fixture-session-b';adminSessionEpoch++;");
      if (kind === 'json') resolveJson({ orders: [{ customer: 'OLD_PRIVATE_ORDER' }] });
      else if (kind === 'network-error') view.requests[0].reject(new TypeError('Old connection failed'));
      else view.respond(0, { orders: [{ customer: 'OLD_PRIVATE_ORDER' }], error: 'Old server error' }, kind === 'unauthorized' ? 401 : kind === 'http-error' ? 503 : 200);
      await rejection;
      assert.equal(view.run('token'), 'fixture-session-b', 'An old 401 must not log out the new session');
      assert.equal(view.get('#olist').innerHTML, '');
      assert.equal(view.get('#aerr').textContent, '');
      assert.deepEqual(view.alerts, []);
    });
  }
});

test('a current 401 clears private state and reports expiration only on the login form', async () => {
  const view = panel();
  view.get('#olist').innerHTML = 'PRIVATE_ORDER';
  const loading = view.context.loadOrders();
  const rejection = assert.rejects(loading, stale);
  view.respond(0, { error: 'Sessão expirada' }, 401);
  await rejection;
  assert.equal(view.run('token'), '');
  assert.equal(view.get('#olist').innerHTML, '');
  assert.match(view.get('#lerr').textContent, /Sessão expirada/);
  assert.equal(view.get('#aerr').textContent, '');
  const requests = view.requests.length;
  await assert.rejects(view.context.api('/orders'), stale);
  assert.equal(view.requests.length, requests, 'Calls after logout must not send a request');
});

test('errors belonging to a previous session stay silent after a new login', async () => {
  const view = panel();
  const request = view.context.api('/orders');
  view.respond(0, { error: 'PRIVATE_ERROR_MARKER' }, 400);
  const error = await request.catch(value => value);
  view.context.logout();
  view.run("token='fixture-session-b';adminSessionEpoch++;");
  view.context.oldError = error;
  view.run('showError(oldError);showAdminAlert(oldError)');
  assert.equal(view.get('#aerr').textContent, '');
  assert.deepEqual(view.alerts, []);
});

test('delayed logins cannot reopen the panel or unlock a newer login attempt', async () => {
  const view = panel();
  view.context.logout();
  view.get('#pw').value = 'isolated-fixture-password';
  const oldLogin = view.get('#login').onsubmit({ preventDefault() {} });
  view.context.logout();
  const newLogin = view.get('#login').onsubmit({ preventDefault() {} });
  view.respond(0, { token: 'discarded-fixture-token' });
  await oldLogin;
  assert.equal(view.run('token'), '');
  assert.equal(view.get('#login button').disabled, true, 'Finishing an old request must not enable a newer login button');
  view.respond(1, { error: 'Senha incorreta' }, 401);
  await newLogin;
  assert.equal(view.get('#login button').disabled, false);
  assert.match(view.get('#lerr').textContent, /Senha incorreta/);
  assert.equal(view.storage.has('t'), false);
});

test('a fresh successful login opens the panel and starts reads using only the new token', async () => {
  const view = panel();
  view.context.logout();
  view.get('#pw').value = 'isolated-fixture-password';
  const login = view.get('#login').onsubmit({ preventDefault() {} });
  view.respond(0, { token: 'fixture-session-b' });
  await login;
  assert.equal(view.run('token'), 'fixture-session-b');
  assert.equal(view.storage.get('t'), 'fixture-session-b');
  assert.equal(view.get('#app').hidden, false);
  assert.equal(view.get('#login').hidden, true);
  assert.equal(view.get('#pw').value, '');
  assert.equal(view.get('#login button').disabled, false);
  assert.deepEqual(view.requests.slice(1).map(request => request.url).sort(), ['/api/admin/banner', '/api/admin/orders', '/api/admin/products']);
  assert.ok(view.requests.slice(1).every(request => request.options.headers['x-token'] === 'fixture-session-b'));
  view.context.logout();
  view.requests.slice(1).forEach(request => request.reject(new TypeError('Closed fixture request')));
  await tick();
  assert.equal(view.get('#aerr').textContent, '');
});

test('old mutation callbacks do not overwrite fresh fields, feedback or busy buttons', async t => {
  for (const form of ['banner', 'movement']) {
    await t.test(form, async () => {
      const view = panel();
      view.run("products=[{id:1,name:'Isolated stock product',sale_unit:'weight',stock_grams:1000}]");
      view.get('#movement-product').value = '1';
      view.get('#movement-quantity').value = '100';
      view.get('#movement-note').value = 'Isolated purchase';
      const button = view.get(form === 'banner' ? '#banner-save' : '#movement-submit');
      const feedback = view.get(form === 'banner' ? '#banner-status' : '#movement-feedback');
      const save = view.get(form === 'banner' ? '#banner-form' : '#stock-movement-form').onsubmit({ preventDefault() {} });
      view.context.logout();
      view.run("token='fixture-session-b';adminSessionEpoch++;");
      button.disabled = true;
      feedback.textContent = 'New session feedback';
      view.get('#movement-note').value = 'New session note';
      view.respond(0, { ok: true });
      await save;
      assert.equal(feedback.textContent, 'New session feedback');
      assert.equal(button.disabled, true);
      assert.equal(view.get('#movement-note').value, 'New session note');
      assert.equal(view.requests.length, 1, 'The old mutation must not start a read under the new token');
      assert.equal(view.get('#aerr').textContent, '');
    });
  }
});

test('logout aborts photo reads and prevents a pending product save from using a new session', async () => {
  const view = panel();
  for (const [id, value] of Object.entries({ pname: 'Isolated image product', pprice: '12,00', pstock: '1000', pweight: '1000', 'psale-unit': 'weight' })) view.get(`#${id}`).value = value;
  view.get('#pimage').files = [{ type: 'image/png', size: 20 }];
  view.get('#pimage').onchange();
  const oldImageError = view.get('#pimage-preview').onerror;
  const save = view.get('#pf').onsubmit({ preventDefault() {} });
  assert.equal(view.imageReaders.length, 1);
  view.context.logout();
  view.run("token='fixture-session-b';adminSessionEpoch++;");
  view.get('#psave').disabled = true;
  view.get('#pimage-preview').src = '/new-session-photo';
  oldImageError();
  await save;
  assert.equal(view.requests.length, 0, 'The old image must not be posted using the new token');
  assert.equal(view.get('#psave').disabled, true, 'An old finally block must not unlock a new save');
  assert.equal(view.get('#pimage-error').textContent, '');
  assert.deepEqual(view.alerts, []);
});

test('an old catalog reorder cannot reload products or unlock ordering in a newer session', async () => {
  const view = panel();
  view.run("products=[{id:1,name:'Old product'},{id:2,name:'Other product'}]");
  const save = view.context.moveProductInCatalog(1, 2);
  assert.equal(view.requests[0].url, '/api/admin/products/1/order');
  assert.deepEqual(JSON.parse(view.requests[0].options.body), { position: 2, expected_order: [1, 2] });
  assert.equal(view.run('productOrderBusy'), true);
  view.context.logout();
  assert.equal(view.get('#product-order-feedback').textContent, '');
  assert.equal(view.run('productOrderBusy'), false);
  view.run("token='fixture-session-b';adminSessionEpoch++;productOrderBusy=true;products=[{id:3,name:'Fresh product'}]");
  view.get('#pname').value = 'Fresh product draft';
  view.get('#product-order-feedback').textContent = 'Fresh ordering feedback';
  view.get('#product-list-table').setAttribute('aria-busy', 'true');
  view.respond(0, { ok: true, id: 1, position: 2 });
  await save;
  assert.equal(view.requests.length, 1, 'The old mutation must not reload the catalog using a new token');
  assert.equal(view.run('productOrderBusy'), true, 'An old finally block must not unlock a new reorder');
  assert.equal(view.get('#product-list-table').getAttribute('aria-busy'), 'true');
  assert.equal(view.get('#product-order-feedback').textContent, 'Fresh ordering feedback');
  assert.equal(view.get('#pname').value, 'Fresh product draft');
  assert.equal(view.run('products[0].id'), 3);
  assert.equal(view.get('#aerr').textContent, '');
});
