const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { mock } = require('node:test');

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'puro-browser-'));
  const workspace = path.join(__dirname, '..');
  const artifacts = path.join(workspace, 'artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  process.env.DB_FILE = path.join(temporary, 'preview.db');
  process.env.ADMIN_PASSWORD = 'preview-only-password';
  // Freeze only the server date; browser timers and automatic UI refresh stay real.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-07T15:00:00Z').getTime() });
  const { db } = require('../src/database');
  db.function('current_timestamp', () => new Date().toISOString().replace('T', ' ').slice(0, 19));
  db.exec('UPDATE products SET stock_grams = 5000');
  const app = require('../src/app').createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  console.log('Temporary preview server ready. Launching headless Chrome.');
  const browserPath = process.env.PREVIEW_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=32190', `--user-data-dir=${path.join(temporary, 'browser')}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let browserError;
  browser.on('error', error => { browserError = error; });
  let socket;
  const browserClosed = new Promise(resolve => browser.once('exit', resolve));
  try {
    let target;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (browserError) throw browserError;
      try {
        const targets = await (await fetch('http://127.0.0.1:32190/json/list', { signal: AbortSignal.timeout(700) })).json();
        target = targets.find(item => item.type === 'page');
        if (target) break;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(target, 'Headless browser did not start');
    console.log('Headless Chrome ready.');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const pending = new Map();
    let sequence = 0;
    const runtimeErrors = [];
    const cspViolations = [];
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === 'Runtime.bindingCalled' && message.params.name === '__previewCspViolation') cspViolations.push(JSON.parse(message.params.payload));
      const operation = pending.get(message.id);
      if (operation) {
        pending.delete(message.id);
        message.error ? operation.reject(new Error(message.error.message)) : operation.resolve(message.result);
      }
    };
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 20000);
      pending.set(id, {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await command('Runtime.enable');
    await command('Page.enable');
    await command('Runtime.addBinding', { name: '__previewCspViolation' });
    await command('Page.addScriptToEvaluateOnNewDocument', { source: "document.addEventListener('securitypolicyviolation',event=>window.__previewCspViolation(JSON.stringify({directive:event.effectiveDirective,blocked:event.blockedURI})));" });
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate("document.querySelectorAll('.card').length === 9 && document.querySelector('.hero-photo').complete")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await evaluate('Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 5000))])');
    const desktop = await evaluate(`({ cards: document.querySelectorAll('.card').length, width: document.documentElement.scrollWidth, viewport: innerWidth, logos: [...document.querySelectorAll('.brand-logo img, .brand-ring img')].every(img => img.naturalWidth > 0), logoRatio: document.querySelector('.brand-ring img').getBoundingClientRect().width / document.querySelector('.brand-ring img').getBoundingClientRect().height, photo: document.querySelector('.hero-photo').naturalWidth })`);
    assert.equal(desktop.cards, 9);
    assert.ok(desktop.width <= desktop.viewport, 'Desktop layout overflows horizontally');
    assert.equal(desktop.logos, true);
    assert.equal(desktop.logoRatio, 1, 'The vertical logo must keep its original proportions');
    assert.ok(desktop.photo > 0);
    async function screenshot(name) {
      const { cssContentSize } = await command('Page.getLayoutMetrics');
      const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 } });
      fs.writeFileSync(path.join(artifacts, name), Buffer.from(data, 'base64'));
    }
    await screenshot('store-desktop.png');
    // The current hero can be static or rotate when a second image is configured.
    if (await evaluate("document.querySelectorAll('[data-hero-image]').length>1")) {
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await waitFor("document.querySelector('[data-hero-promotion]').naturalWidth>0");
    assert.equal(await evaluate("document.querySelector('[data-hero-images-toggle], [data-hero-image-controls], [data-hero-image-dot]')"),null,'The carousel controls must be removed');
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const initialImage = await evaluate("document.querySelector('[data-hero-images]').dataset.currentImage");
    const heroGeometry = "[...document.querySelectorAll('#hero-title,.hero-copy>p,.hero-actions a')].map(node=>({text:node.textContent,href:node.getAttribute('href'),x:node.tagName==='A'?null:node.getBoundingClientRect().x-document.querySelector('.hero').getBoundingClientRect().x,y:node.tagName==='A'?null:node.getBoundingClientRect().y-document.querySelector('.hero').getBoundingClientRect().y,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}))";
    const originalGeometry = await evaluate(heroGeometry);
    assert.deepEqual(originalGeometry.slice(-2).map(node=>node.href),['#produtos','/ofertas']);
    await command('Emulation.setEmulatedMedia',{features:[]});
    await evaluate("new Promise(resolve=>setTimeout(resolve,3150))");
    assert.equal(await evaluate("document.querySelector('[data-hero-images]').dataset.currentImage"),initialImage,'The image must stay visible for more than three seconds');
    await evaluate("new Promise(resolve=>setTimeout(resolve,3150))");
    assert.notEqual(await evaluate("document.querySelector('[data-hero-images]').dataset.currentImage"),initialImage,'The image must change after six seconds');
    assert.deepEqual(await evaluate(heroGeometry),originalGeometry,'Image rotation must preserve the original text, links and button sizes');
    await evaluate("new Promise(resolve=>setTimeout(resolve,6000))");
    assert.equal(await evaluate("document.querySelector('[data-hero-images]').dataset.currentImage"),initialImage,'Automatic image rotation must repeat');
    await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await evaluate("new Promise(resolve=>setTimeout(resolve,6150))");
    assert.equal(await evaluate("document.querySelector('[data-hero-images]').dataset.currentImage"),initialImage,'Reduced motion must stop automatic rotation');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('[data-hero-promotion]')).objectFit"),'contain');
    if(initialImage==='0') {
      await command('Emulation.setEmulatedMedia',{features:[]});
      await evaluate("new Promise(resolve=>setTimeout(resolve,6150))");
      await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    }
    for (const width of [360,390,430,768,1024,1440]) {
      await command('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<768});
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const bounds=await evaluate("(() => {const frame=document.querySelector('.hero-visual').getBoundingClientRect();const photo=document.querySelector('[data-hero-promotion]');const box=photo.getBoundingClientRect();return {frameWidth:frame.width,frameHeight:frame.height,photoWidth:box.width,photoHeight:box.height,ratio:photo.naturalWidth/photo.naturalHeight,buttons:[...document.querySelectorAll('.hero-actions a')].every(link=>link.checkVisibility()),gradient:getComputedStyle(document.querySelector('.hero-visual'),'::after').opacity,copy:getComputedStyle(document.querySelector('.hero-copy')).visibility};})()");
      assert.equal(bounds.frameWidth,bounds.photoWidth,'Promotion must fill the full width of the photo area');
      assert.equal(bounds.frameHeight,bounds.photoHeight,'Promotion must fill the full height of the photo area');
      if(width>=768) assert.ok(await evaluate("document.querySelector('.hero').getBoundingClientRect().height<=400"), 'Desktop banner returns to its original compact height');
      assert.equal(bounds.buttons,true);
      assert.equal(bounds.gradient,'0','No gradient should conceal the promotional image');
      if(width>=768) assert.equal(bounds.copy,'hidden','The promotional artwork must have no duplicate heading over it');
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
      if([390,1440].includes(width)) {
        const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        fs.writeFileSync(path.join(artifacts,`hero-full-promotion-${width}.png`),Buffer.from(shot.data,'base64'));
      }
    }
    await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await command('Emulation.setEmulatedMedia',{features:[]});
    console.log('Hero rotation passed: six-second interval, no controls, reduced motion, preserved purchase buttons and six widths.');
    } else {
      assert.equal(await evaluate("document.querySelectorAll('[data-hero-image]').length"), 1);
      assert.ok(await evaluate("document.querySelector('.hero-actions a').getAttribute('href')==='#produtos' && document.querySelector('.hero-actions a:last-child').getAttribute('href')==='/ofertas'"));
      assert.ok(await evaluate("document.querySelector('.hero-photo-light').naturalWidth>0"));
      console.log('Static hero passed: current artwork and purchase buttons preserved.');
    }
    const selection = await evaluate(`(() => {
      const card = document.querySelector('[data-product="1"]');
      card.querySelector('[data-weight="250"]').click();
      const price = card.querySelector('[data-portion-price]').textContent;
      card.querySelector('[data-add]').click();
      card.querySelector('[data-weight="500"]').click(); card.querySelector('[data-add]').click();
      card.querySelector('[data-weight="custom"]').click();
      const input = card.querySelector('[data-custom-weight]'); input.value = '333'; input.dispatchEvent(new Event('input', {bubbles:true})); card.querySelector('[data-add]').click();
      document.querySelector('#cartBtn').click();
      return {price, cart:JSON.parse(localStorage.getItem('puro-cart-weight-v1')), rows:document.querySelectorAll('.it').length, focus:document.activeElement.id, custom:!card.querySelector('.custom-weight').hidden};
    })()`);
    assert.match(selection.price, /15,00/);
    assert.equal(selection.rows, 3);
    assert.equal(selection.cart['1:333'].weight_grams, 333);
    assert.equal(selection.focus, 'closeCart');
    assert.equal(selection.custom, true);
    await evaluate("document.querySelector('#toast').hidden=true; new Promise(resolve => setTimeout(resolve, 300))");
    const cartShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(artifacts, 'store-cart.png'), Buffer.from(cartShot.data, 'base64'));
    await evaluate("document.querySelector('#closeCart').click();document.querySelector('[data-product=\"1\"]').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>setTimeout(resolve,150));");
    const customWeightDesktop = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(artifacts, 'custom-weight-desktop.png'), Buffer.from(customWeightDesktop.data, 'base64'));
    await evaluate("document.querySelector('#search').value = 'hibisco'; document.querySelector('#search').dispatchEvent(new Event('input')); ");
    assert.equal(await evaluate("[...document.querySelectorAll('.card')].filter(card=>!card.hidden).length"), 1);
    await evaluate("document.querySelector('#search').value=''; document.querySelector('#search').dispatchEvent(new Event('input')); ");
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("scrollTo({top:0,behavior:'instant'}); new Promise(resolve => setTimeout(resolve, 200))");
    assert.equal(await evaluate('document.documentElement.scrollWidth'), 390);
    await screenshot('store-mobile.png');
    await evaluate("document.querySelector('[data-product=\"1\"]').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>setTimeout(resolve,150));");
    const customWeightMobile = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(artifacts, 'custom-weight-mobile.png'), Buffer.from(customWeightMobile.data, 'base64'));
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/admin` });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate("typeof document.querySelector('#login')?.onsubmit === 'function'")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await evaluate("document.querySelector('#pw').value='preview-only-password'; document.querySelector('#login').requestSubmit();");
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate("document.querySelectorAll('#plist tr').length === 9")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await evaluate("document.querySelectorAll('#plist tr').length"), 9, JSON.stringify(runtimeErrors));
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await screenshot('admin-desktop.png');
    await evaluate("document.querySelector('.tabs [data-t=\"pr\"]').click();");
    async function waitFor(expression) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Browser condition timed out: ' + expression);
    };
    // Product filters operate on the list without changing data or the edit form.
    const filterFixtures = db.prepare('SELECT id, name, category, sale_unit, stock_grams, stock_units, active FROM products WHERE id BETWEEN 2 AND 5').all();
    db.prepare('UPDATE products SET active=0, stock_grams=3000 WHERE id=2').run();
    db.prepare('UPDATE products SET stock_grams=0 WHERE id=3').run();
    db.prepare("UPDATE products SET sale_unit='unit', stock_units=3 WHERE id=4").run();
    db.prepare("UPDATE products SET sale_unit='unit', stock_units=4 WHERE id=5").run();
    await evaluate('loadProducts()');
    const setProductFilter = async (id, value) => evaluate(`(() => { const field=document.querySelector('#product-filter-${id}');field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('${id === 'search' ? 'input' : 'change'}'));return [...document.querySelectorAll('#plist [data-e]')].map(button=>Number(button.dataset.e)).sort((a,b)=>a-b); })()`);
    const clearProductFilters = () => evaluate("document.querySelector('#product-filters-clear').click()");
    assert.deepEqual(await setProductFilter('search', 'amendoas'), [5], 'Search ignores accents');
    await clearProductFilters();
    assert.deepEqual(await setProductFilter('sale', 'unit'), [4,5]);
    assert.deepEqual(await setProductFilter('stock', 'low'), [4], 'Low unit stock includes exactly three units');
    await clearProductFilters();
    assert.deepEqual(await setProductFilter('stock', 'low'), [2,3,4], 'Low stock includes 3 kg, zero and 3 units');
    assert.deepEqual(await setProductFilter('active', 'hidden'), [2], 'Filters can be combined');
    await clearProductFilters();
    assert.deepEqual(await setProductFilter('stock', 'empty'), [3]);
    await clearProductFilters();
    assert.equal((await setProductFilter('stock', 'available')).includes(3), false);
    await clearProductFilters();
    const category = filterFixtures.find(product=>product.id===5).category;
    assert.deepEqual(await setProductFilter('category', category), [4,5]);
    await evaluate('loadProducts()');
    assert.equal(await evaluate("document.querySelector('#product-filter-category').value"), category, 'Refreshing preserves the selected category');
    await clearProductFilters();
    await evaluate("document.querySelector('[data-e=\"2\"]').click()");
    assert.deepEqual(await setProductFilter('search', 'produto inexistente xyz'), []);
    assert.equal(await evaluate("document.querySelector('#product-filter-empty').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#product-list-table').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#pid').value"), '2', 'Filtering preserves the edit form');
    await clearProductFilters();
    assert.equal(await evaluate("document.querySelectorAll('#plist tr').length"), 9);
    assert.equal(await evaluate("document.querySelector('#product-filters-clear').disabled"), true);
    // The organizational filter includes old default categories and missing values.
    assert.deepEqual(await setProductFilter('category', 'Sem categoria'), []);
    assert.match(await evaluate("document.querySelector('#product-filter-empty').textContent"), /Todos os produtos/);
    const categoryFixtures = db.prepare('SELECT id, category FROM products ORDER BY id').all();
    const updateCategory = db.prepare('UPDATE products SET category=? WHERE id=?');
    try {
      [null, '', '  \t ', 'Geral', ' geral  ', 'Sem categoria', ' SEM   CATEGORIA '].forEach((category, index) => updateCategory.run(category, index + 1));
      updateCategory.run('__uncategorized__', 8);
      await evaluate('loadProducts()');
      assert.equal(await evaluate("document.querySelector('#product-filter-category').value"), 'Sem categoria');
      assert.deepEqual(await setProductFilter('category', 'Sem categoria'), [1,2,3,4,5,6,7]);
      assert.equal(await evaluate("document.querySelectorAll('#product-filter-category option[value=\"Sem categoria\"]').length"), 1);
      assert.equal(await evaluate("document.querySelector('#product-filter-category-help').hidden"), false);
      for (let id=1;id<=7;id++) {
        await evaluate(`editProduct(products.find(product=>product.id===${id}))`);
        assert.equal(await evaluate("document.querySelector('#pcat').value"), '', 'Missing/default categories select Sem categoria in the editor');
      }
      await evaluate('editProduct(products.find(product=>product.id===2))');
      assert.ok(await evaluate("[...document.querySelectorAll('#plist [data-label=\"Categoria\"]')].every(cell=>cell.textContent==='Sem categoria')"));
      assert.deepEqual(await setProductFilter('active', 'hidden'), [2]);
      await clearProductFilters();
      await setProductFilter('category', 'Sem categoria');
      assert.deepEqual(await setProductFilter('sale', 'unit'), [4,5]);
      assert.deepEqual(await setProductFilter('stock', 'low'), [4]);
      await clearProductFilters();
      await setProductFilter('category', 'Sem categoria');
      assert.deepEqual(await setProductFilter('search', filterFixtures.find(product=>product.id===2).name), [2]);
      assert.equal(await evaluate("document.querySelector('#pid').value"), '2', 'Filtering uncategorized products preserves the edit form');
      await clearProductFilters();
      await setProductFilter('category', 'Sem categoria');
      for (let id=1;id<=7;id++) updateCategory.run('Organizados', id);
      await evaluate('loadProducts()');
      assert.equal(await evaluate("document.querySelector('#product-filter-category').value"), 'Sem categoria', 'The filter stays selected after the last product receives a category');
      assert.equal(await evaluate("document.querySelectorAll('#plist tr').length"), 0);
      assert.match(await evaluate("document.querySelector('#product-filter-empty').textContent"), /Todos os produtos/);
      assert.deepEqual(await setProductFilter('category', '__uncategorized__'), [8], 'A real category named like a sentinel remains a normal category');
    } finally {
      for (const product of categoryFixtures) updateCategory.run(product.category, product.id);
      await clearProductFilters();
      await evaluate('loadProducts()');
    }
    console.log('Uncategorized products passed: null/blank/default categories, combined filters, edit form, refresh, completed organization and clear.');
    for (const product of filterFixtures) db.prepare('UPDATE products SET sale_unit=?,stock_grams=?,stock_units=?,active=? WHERE id=?').run(product.sale_unit,product.stock_grams,product.stock_units,product.active,product.id);
    await evaluate('(async () => { await loadProducts();document.querySelector("#rst").click(); })()');
    await waitFor("document.querySelectorAll('#plist tr').length === 9");
    console.log('Admin product filters passed: accent-insensitive search, category, combined stock/unit/visibility, thresholds, empty state, clear, refresh and unchanged edit form.');
    // Product categories use existing choices and preserve an optional new-category draft.
    const categoryEditSnapshot = db.prepare('SELECT category, price_cents, stock_grams, stock_units FROM products WHERE id=2').get();
    const categoryMovementsBefore = db.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count;
    try {
      assert.equal(await evaluate("document.querySelector('#pcat').tagName"), 'SELECT');
      assert.ok(await evaluate("[...document.querySelector('#pcat').options].some(option=>option.value==='Grãos')"));
      await evaluate("document.querySelector('[data-e=\"2\"]').click()");
      assert.equal(await evaluate("document.querySelector('#pcat').value"), categoryEditSnapshot.category);
      assert.equal(await evaluate("Number(document.querySelector('#pstock').value)"), categoryEditSnapshot.stock_grams);
      await evaluate("document.querySelector('#pcat').value='Chás';document.querySelector('#pcat').dispatchEvent(new Event('change'));document.querySelector('#pf').requestSubmit()");
      await waitFor("!document.querySelector('#psave').disabled && document.querySelector('#pid').value===''");
      assert.equal(db.prepare('SELECT category FROM products WHERE id=2').get().category, 'Chás');
      await evaluate("document.querySelector('[data-e=\"2\"]').click();document.querySelector('#pcat').value=NEW_CATEGORY_OPTION;document.querySelector('#pcat').dispatchEvent(new Event('change'));document.querySelector('#pcat-new').value='   ';document.querySelector('#pf').requestSubmit()");
      assert.match(await evaluate("document.querySelector('#aerr').textContent"), /nome da nova categoria/);
      assert.equal(db.prepare('SELECT category FROM products WHERE id=2').get().category, 'Chás');
      await evaluate("document.querySelector('#pcat-new').value='Categoria de teste';loadProducts()");
      await waitFor("document.querySelector('#pcat').value===NEW_CATEGORY_OPTION && !document.querySelector('#pcat-new').disabled");
      assert.equal(await evaluate("document.querySelector('#pcat-new').value"), 'Categoria de teste');
      assert.equal(await evaluate("document.querySelector('#pcat-new').required"), true);
      await evaluate("document.querySelector('#pcat').value='Grãos';document.querySelector('#pcat').dispatchEvent(new Event('change'))");
      assert.equal(await evaluate("document.querySelector('#pcat-new').disabled && document.querySelector('#pcat-new-label').hidden"), true);
      await evaluate("document.querySelector('#pcat').value=NEW_CATEGORY_OPTION;document.querySelector('#pcat').dispatchEvent(new Event('change'));document.querySelector('#pf').requestSubmit()");
      await waitFor("!document.querySelector('#psave').disabled && document.querySelector('#pid').value===''");
      assert.equal(db.prepare('SELECT category FROM products WHERE id=2').get().category, 'Categoria de teste');
      assert.ok(await evaluate("[...document.querySelector('#pcat').options].some(option=>option.value==='Categoria de teste') && [...document.querySelector('#product-filter-category').options].some(option=>option.value==='Categoria de teste')"));
      assert.equal(await evaluate("document.querySelector('#pcat').value==='' && document.querySelector('#pcat-new').value==='' && document.querySelector('#pcat-new').disabled"), true);
      await evaluate("document.querySelector('#pcat').value='Categoria de teste'");
      db.prepare('UPDATE products SET category=? WHERE id=2').run(categoryEditSnapshot.category);
      await evaluate('loadProducts()');
      assert.equal(await evaluate("document.querySelector('#pcat').value"), 'Categoria de teste', 'A draft category survives when the last product in that category changes');
      await evaluate("document.querySelector('#rst').click()");
      assert.equal(await evaluate("[...document.querySelector('#pcat').options].some(option=>option.value==='Categoria de teste')"), false);
      const saved = db.prepare('SELECT price_cents, stock_grams, stock_units FROM products WHERE id=2').get();
      assert.deepEqual({...saved}, {price_cents:categoryEditSnapshot.price_cents,stock_grams:categoryEditSnapshot.stock_grams,stock_units:categoryEditSnapshot.stock_units});
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count, categoryMovementsBefore);
    } finally {
      db.prepare('UPDATE products SET category=? WHERE id=2').run(categoryEditSnapshot.category);
      await evaluate("loadProducts().then(()=>document.querySelector('#rst').click())");
    }
    console.log('Category selector passed: existing categories, uncategorized editing, save, new-category validation/draft, refresh/reset and unchanged prices/stock.');
    // Manual ordering changes only catalog positions, preserving filters and an unsaved product form.
    const { PRODUCT_ORDER_SQL } = require('../src/product-order');
    const originalOrder = db.prepare(`SELECT id,display_order FROM products ORDER BY ${PRODUCT_ORDER_SQL}`).all();
    const protectedProducts = () => db.prepare('SELECT * FROM products ORDER BY id').all().map(({display_order,...product}) => product);
    const productsBeforeOrdering = protectedProducts();
    const movementsBeforeOrdering = db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n;
    const currentOrder = () => db.prepare(`SELECT id FROM products ORDER BY ${PRODUCT_ORDER_SQL}`).all().map(product => product.id);
    const listOrder = () => evaluate("[...document.querySelectorAll('#plist [data-e]')].map(button=>Number(button.dataset.e))");
    const moveInPanel = async (id, action, position) => {
      await evaluate(`${position === undefined ? '' : `document.querySelector('#product-order-${id}').value=${JSON.stringify(String(position))};`}document.querySelector('[data-product-order="${id}"][data-order-action="${action}"]').click();`);
      await waitFor("!productOrderBusy && document.querySelector('#product-order-feedback').textContent.includes('movido')");
    };
    const moveSequence = (sequence, id, position) => {
      const result=sequence.filter(productId=>productId!==id);result.splice(position-1,0,id);return result;
    };
    try {
      await clearProductFilters();
      await evaluate("document.querySelector('[data-e=\"2\"]').click();document.querySelector('#pname').value='Rascunho mantido ao ordenar';");
      let expected = originalOrder.map(product=>product.id);
      const target = expected.at(-1);
      await moveInPanel(target, 'move', 1);
      expected=moveSequence(expected,target,1);
      assert.deepEqual(await listOrder(), expected);
      assert.deepEqual((await (await fetch(`http://127.0.0.1:${server.address().port}/api/products`)).json()).products.map(product=>product.id),expected);
      assert.equal(await evaluate("document.querySelector('#pname').value"),'Rascunho mantido ao ordenar');
      assert.equal(await evaluate("document.querySelector('#pid').value"),'2');
      await setProductFilter('category','Grãos');
      const grainRows=await listOrder();
      const filteredTarget=grainRows.at(-1);
      const preceding=grainRows.at(-2);
      const upPosition=expected.indexOf(preceding)+1;
      await moveInPanel(filteredTarget,'up');
      expected=moveSequence(expected,filteredTarget,upPosition);
      assert.deepEqual(currentOrder(),expected);
      assert.equal(await evaluate("document.querySelector('#product-filter-category').value"),'Grãos');
      await moveInPanel(filteredTarget,'down');
      expected=moveSequence(expected,filteredTarget,expected.indexOf(preceding)+1);
      assert.deepEqual(currentOrder(),expected);
      await clearProductFilters();
      await moveInPanel(target,'move',expected.length);
      expected=moveSequence(expected,target,expected.length);
      assert.deepEqual(await listOrder(),expected);
      await evaluate(`document.querySelector('#product-order-${target}').value='0';document.querySelector('[data-product-order="${target}"][data-order-action="move"]').click();`);
      assert.match(await evaluate("document.querySelector('#product-order-feedback').textContent"),/posição inteira/);
      assert.equal(await evaluate(`document.querySelector('#product-order-${target}').getAttribute('aria-invalid')`),'true');
      assert.deepEqual(currentOrder(),expected);
      // Simulate another administrator moving a product before this panel saves its older snapshot.
      await evaluate(`api('/products/${target}/order','PATCH',{position:1,expected_order:products.map(product=>product.id)})`);
      const otherAdminOrder=currentOrder();
      await evaluate(`document.querySelector('#product-order-${target}').value='2';document.querySelector('[data-product-order="${target}"][data-order-action="move"]').click();`);
      await waitFor("!productOrderBusy && document.querySelector('#product-order-feedback').textContent.includes('lista de produtos mudou')");
      assert.deepEqual(currentOrder(),otherAdminOrder);
      assert.deepEqual(await listOrder(),otherAdminOrder);
      assert.equal(await evaluate("document.querySelector('#pname').value"),'Rascunho mantido ao ordenar');
      assert.deepEqual(protectedProducts(),productsBeforeOrdering);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,movementsBeforeOrdering);
      for(const width of [360,390,430,768,1024,1440]) {
        await command('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<768});
        for(const theme of ['light','dark']) {
          if(await evaluate('document.documentElement.dataset.theme')!==theme) await evaluate("document.querySelector('[data-theme-toggle]').click()");
          await evaluate("document.querySelector('.product-order-cell').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));");
          assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),`Ordering must fit ${theme} ${width}`);
          assert.ok(await evaluate("[...document.querySelectorAll('.product-order-controls button,.product-order-controls input')].every(control=>control.getBoundingClientRect().height>=44)"));
          if([390,1440].includes(width)) {
            const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
            fs.writeFileSync(path.join(artifacts,`product-order-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
          }
        }
      }
    } finally {
      for(const product of originalOrder) db.prepare('UPDATE products SET display_order=? WHERE id=?').run(product.display_order,product.id);
      await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      await clearProductFilters();
      await evaluate("loadProducts().then(()=>document.querySelector('#rst').click())");
    }
    console.log('Product ordering passed: first/last positions, filtered arrows, stale snapshot, intact form/prices/stock/photos, saved catalog order and six widths in both themes.');
    const choosePhoto = async filename => {
      const { root } = await command('DOM.getDocument');
      const { nodeId } = await command('DOM.querySelector', { nodeId: root.nodeId, selector: '#pimage' });
      await command('DOM.setFileInputFiles', { nodeId, files: [path.join(workspace, 'public/images', filename)] });
      await waitFor("!document.querySelector('#pimage-box').hidden && document.querySelector('#pimage-preview').naturalWidth > 0");
    };
    const assertPhotoFrame = async selector => {
      const dimensions = await evaluate(`(() => {
        const photo=document.querySelector(${JSON.stringify(selector)}), frame=photo.parentElement;
        const bounds=photo.getBoundingClientRect(), frameBounds=frame.getBoundingClientRect();
        return {frameWidth:frame.clientWidth,frameHeight:frame.clientHeight,photoWidth:bounds.width,photoHeight:bounds.height,left:bounds.left-frameBounds.left-frame.clientLeft,top:bounds.top-frameBounds.top-frame.clientTop};
      })()`);
      assert.ok(Math.abs(dimensions.photoHeight-dimensions.frameHeight)<1, `${selector}: the image box must fit the frame height for saved positioning to work`);
      assert.ok(Math.abs(dimensions.photoWidth-dimensions.frameWidth)<1, `${selector}: the image box must fit the frame width`);
      assert.ok(Math.abs(dimensions.left)<1 && Math.abs(dimensions.top)<1, `${selector}: the image box must align with its frame`);
    };
    await evaluate("document.querySelector('#pname').value='Produto com foto';document.querySelector('#pprice').value='12,50';document.querySelector('#pstock').value='1200';document.querySelector('#pcat').value='Grãos';");
    await choosePhoto('hero-natural.png');
    await assertPhotoFrame('#pimage-preview');
    const centeredPreview = await evaluate(`(() => {
      const x=document.querySelector('#pimage-x'), y=document.querySelector('#pimage-y');
      x.value=15; y.value=80; x.dispatchEvent(new Event('input')); y.dispatchEvent(new Event('input'));
      const moved=document.querySelector('#pimage-preview').style.objectPosition;
      document.querySelector('#pimage-center').click();
      return {moved,centered:document.querySelector('#pimage-preview').style.objectPosition};
    })()`);
    assert.equal(centeredPreview.moved, '15% 80%');
    assert.equal(centeredPreview.centered, '50% 50%');
    await evaluate("document.querySelector('#pimage-fit').value='contain';document.querySelector('#pimage-fit').dispatchEvent(new Event('change'));document.querySelector('#pimage-x').value=25;document.querySelector('#pimage-x').dispatchEvent(new Event('input'));");
    await screenshot('admin-photo-preview.png');
    await evaluate("document.querySelector('#pf').requestSubmit();");
    await waitFor("document.querySelectorAll('#plist tr').length === 10 && !document.querySelector('#psave').disabled");
    const createdImage = db.prepare('SELECT image_version FROM products WHERE id = 10').get().image_version;
    assert.ok(createdImage);
    assert.equal(db.prepare('SELECT image_position_x FROM products WHERE id = 10').get().image_position_x, 25);
    await evaluate("document.querySelector('[data-e=\"10\"]').click();");
    await waitFor("document.querySelector('#pimage-preview').naturalWidth > 0");
    assert.equal(await evaluate("document.querySelector('#pimage-x').value"), '25');
    assert.equal(await evaluate("document.querySelector('#pimage-fit').value"), 'contain');
    await evaluate("document.querySelector('#pdesc').value='Descrição editada sem substituir a foto';document.querySelector('#pf').requestSubmit();");
    await waitFor("!document.querySelector('#psave').disabled && document.querySelector('#pid').value === ''");
    assert.equal(db.prepare('SELECT image_version FROM products WHERE id = 10').get().image_version, createdImage);
    await evaluate("document.querySelector('[data-e=\"10\"]').click();");
    await choosePhoto('logo-vertical.png');
    await assertPhotoFrame('#pimage-preview');
    await evaluate("document.querySelector('#pf').requestSubmit();");
    await waitFor("!document.querySelector('#psave').disabled && document.querySelector('#pid').value === ''");
    assert.notEqual(db.prepare('SELECT image_version FROM products WHERE id = 10').get().image_version, createdImage);
    await evaluate("document.querySelector('[data-e=\"10\"]').click();document.querySelector('#pimage-remove').click();document.querySelector('#pf').requestSubmit();");
    await waitFor("!document.querySelector('#psave').disabled && document.querySelector('#pid').value === ''");
    assert.equal(db.prepare('SELECT image_version FROM products WHERE id = 10').get().image_version, '');
    await evaluate("document.querySelector('[data-e=\"1\"]').click();");
    await choosePhoto('hero-natural.png');
    await evaluate("document.querySelector('#pimage-x').value=20;document.querySelector('#pimage-y').value=75;document.querySelector('#pimage-x').dispatchEvent(new Event('input'));document.querySelector('#pimage-y').dispatchEvent(new Event('input'));document.querySelector('#pimage-fit').value='contain';document.querySelector('#pimage-fit').dispatchEvent(new Event('change'));");
    await evaluate("document.querySelector('#pf').requestSubmit();");
    await waitFor("!document.querySelector('#psave').disabled && document.querySelector('#pid').value === ''");
    await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/#produtos` });
    await waitFor("Boolean(document.querySelector('[data-product=\"1\"] .product-photo'))");
    await evaluate("document.querySelector('[data-product=\"1\"]').scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});");
    await waitFor("document.querySelector('[data-product=\"1\"] .product-photo')?.naturalWidth > 0");
    assert.equal(await evaluate("document.querySelector('[data-product=\"1\"] .product-photo').style.objectPosition"), '20% 75%');
    assert.equal(await evaluate("document.querySelector('[data-product=\"1\"] .product-photo').style.objectFit"), 'contain');
    await assertPhotoFrame('[data-product="1"] .product-photo');
    assert.match(await evaluate("document.querySelector('[data-product=\"1\"] .stock-availability').textContent"), /5 kg/);
    await evaluate("document.querySelector('[data-product=\"1\"]').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>setTimeout(resolve,100));");
    const photoShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(artifacts, 'store-product-photo.png'), Buffer.from(photoShot.data, 'base64'));
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await assertPhotoFrame('[data-product="1"] .product-photo');
    assert.equal(await evaluate('document.documentElement.scrollWidth'), 390);
    assert.match(await evaluate("document.querySelector('[data-product=\"1\"] .stock-availability').textContent"), /5 kg/);
    // A portrait fixture also needs to fit the frame at desktop and mobile widths.
    await evaluate(`(() => {
      const photo=document.querySelector('[data-product="1"] .product-photo');
      const canvas=document.createElement('canvas'); canvas.width=400; canvas.height=800;
      const context=canvas.getContext('2d');
      context.fillStyle='#1d5634';context.fillRect(0,0,400,800);
      context.fillStyle='#f4edcc';context.fillRect(20,20,360,760);
      context.fillStyle='#1d5634';context.fillRect(50,200,300,400);
      photo.src=canvas.toDataURL();photo.style.objectFit='contain';photo.style.objectPosition='50% 50%';
    })()`);
    await waitFor("document.querySelector('[data-product=\"1\"] .product-photo').naturalHeight === 800");
    await assertPhotoFrame('[data-product="1"] .product-photo');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await assertPhotoFrame('[data-product="1"] .product-photo');
    await evaluate("document.querySelector('[data-product=\"1\"] .product-photo').click();");
    await waitFor("document.querySelector('#product-image-dialog').open && document.querySelector('#product-image-dialog img').naturalHeight===800 && !document.querySelector('#product-image-dialog img').hidden");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#product-image-dialog img')).objectFit"), 'contain');
    await evaluate("document.querySelector('#product-image-dialog [data-close-dialog]').click();");
    await waitFor("!document.querySelector('#product-image-dialog').open");

    // Feature and regression checks use only this script's temporary database.
    const site = `http://127.0.0.1:${server.address().port}`;
    await command('Page.navigate', { url: site + '/admin' });
    await waitFor("document.querySelectorAll('#plist tr').length === 10");
    assert.equal(await evaluate("document.querySelector('#db').hidden"), false);
    assert.match(await evaluate("document.querySelector('#sales-day').textContent"), /0,00/);
    await evaluate("document.querySelector('.tabs [data-t=\"bn\"]').click();document.querySelector('#banner-active').checked=true;document.querySelector('#banner-title').value='Sabores da semana';document.querySelector('#banner-description').value='Uma selecao de ingredientes para sua rotina.';document.querySelector('#banner-link-label').value='Ver produtos';document.querySelector('#banner-link-url').value='/#produtos';document.querySelector('#banner-title').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#banner-form').requestSubmit();");
    await waitFor("document.querySelector('#banner-status').textContent.includes('publicado')");
    await evaluate("document.querySelector('.tabs [data-t=\"kt\"]').click();");
    await waitFor("document.querySelector('.kit-component select').options.length === 11");
    await evaluate("document.querySelector('#kit-name').value='Kit de teste';document.querySelector('.kit-component select').value='1';document.querySelector('[data-kit-weight]').value='100';document.querySelector('[data-kit-qty]').value='2';document.querySelector('#kit-form').requestSubmit();");
    await waitFor("document.querySelector('#kit-list').textContent.includes('Kit de teste')");
    const psyllium = db.prepare('INSERT INTO products(name, description, category, price_cents, price_weight_grams, stock_grams) VALUES(?,?,?,?,?,?)').run('Psyllium', 'A granel', 'Fibras', 4000, 1000, 5000).lastInsertRowid;
    await evaluate("localStorage.setItem('puro-cart-weight-v1',JSON.stringify({bad:null}));");
    await command('Page.navigate', { url: site });
    await waitFor("document.querySelectorAll('.card').length === 11 && document.querySelector('[data-add-kit]')");
    assert.equal(await evaluate("document.querySelector('#home-banner-title').textContent"), 'Sabores da semana');
    assert.equal(await evaluate("document.querySelector('#cc').textContent"), '0');
    await evaluate("document.querySelector('#search').value='psilium';document.querySelector('#search').dispatchEvent(new Event('input'));");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.card:not([hidden])')].map(card=>Number(card.dataset.product))"), [psyllium]);
    await evaluate(`document.querySelector('[data-product="${psyllium}"] [data-weight="500"]').click();`);
    const shareMessage = new URL(await evaluate(`document.querySelector('[data-product="${psyllium}"] [data-share-product]').href`)).searchParams.get('text');
    assert.match(shareMessage, /20,00/);
    assert.match(shareMessage, /500 g/);
    await command('Page.navigate', { url: shareMessage.split('\n')[2] });
    await waitFor(`document.activeElement?.id === 'product-${psyllium}'`);
    await evaluate(`document.querySelector('[data-product="${psyllium}"] [data-add]').click();document.querySelector('#cartBtn').click();const plus=document.querySelector('#items [data-action="+"]');plus.focus();plus.click();`);
    assert.equal(await evaluate('document.activeElement.dataset.action'), '+');
    // With the other controls disabled, the delivery select must remain in the focus loop.
    await evaluate("document.querySelectorAll('#drawer input,#drawer textarea,#drawer button').forEach(control=>control.disabled=true);document.querySelector('#closeCart').disabled=false;document.querySelector('#delivery-area').focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));");
    assert.equal(await evaluate('document.activeElement.id'), 'closeCart');
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));");
    assert.equal(await evaluate('document.activeElement.id'), 'delivery-area');
    await evaluate("document.querySelectorAll('#drawer input,#drawer textarea,#drawer button').forEach(control=>control.disabled=false);renderCart();document.querySelector('#closeCart').click();");
    await evaluate(`document.querySelector('[data-product="${psyllium}"] [data-weight="custom"]').click();const input=document.querySelector('[data-product="${psyllium}"] [data-custom-weight]');input.value='333';input.dispatchEvent(new Event('input',{bubbles:true}));`);
    db.prepare('UPDATE products SET stock_grams=4000 WHERE id=?').run(psyllium);
    await evaluate('checkPromotion()');
    assert.equal(await evaluate('document.activeElement.value'), '333');
    assert.match(await evaluate(`document.querySelector('[data-product="${psyllium}"] .stock-availability').textContent`), /4 kg/);
    db.prepare('UPDATE products SET stock_grams=0 WHERE id=?').run(psyllium);
    await evaluate('checkPromotion()');
    assert.equal(await evaluate("document.querySelector('#cc').textContent"), '0');
    assert.equal(await evaluate(`document.querySelector('[data-product="${psyllium}"] [data-add]').disabled`), true);
    for (const width of [390, 320]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
      await evaluate("scrollTo({top:0,behavior:'instant'});localStorage.setItem('puro-theme','light');window.dispatchEvent(new StorageEvent('storage',{key:'puro-theme'}));");
      assert.equal(await evaluate('document.documentElement.scrollWidth'), width);
      await screenshot(`review-home-${width}.png`);
      await evaluate("localStorage.setItem('puro-theme','dark');window.dispatchEvent(new StorageEvent('storage',{key:'puro-theme'}));");
      assert.equal(await evaluate('document.documentElement.scrollWidth'), width);
    }
    // A browser that blocks session storage should still be able to log in.
    const { identifier } = await command('Page.addScriptToEvaluateOnNewDocument', { source: "if(location.pathname==='/admin'){Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('Blocked','SecurityError')}})}" });
    await command('Page.navigate', { url: site + '/admin' });
    await waitFor("typeof document.querySelector('#login')?.onsubmit === 'function'");
    await evaluate("document.querySelector('#pw').value='preview-only-password';document.querySelector('#login').requestSubmit();");
    await waitFor("document.querySelector('#dashboard-updated').textContent.includes('Atualizado')");
    await screenshot('review-admin-dark-mobile.png');
    await command('Page.removeScriptToEvaluateOnNewDocument', { identifier });

    // Create a product through the actual form using unit stock rather than grams.
    await evaluate(`document.querySelector('.tabs [data-t="pr"]').click();document.querySelector('#rst').click();document.querySelector('#psale-unit').value='unit';document.querySelector('#psale-unit').dispatchEvent(new Event('change'));document.querySelector('#pname').value='Mel por unidade';document.querySelector('#pprice').value='12,50';document.querySelector('#pstock').value='6';`);
    assert.equal(await evaluate("document.querySelector('#pweight-label').hidden && document.querySelector('#pweight').disabled && document.querySelector('#ppromo').disabled"), true);
    assert.equal(await evaluate("document.querySelector('#pstock-label').textContent"), 'Estoque disponível (unidades)');
    await evaluate("document.querySelector('#pf').requestSubmit();");
    await waitFor("document.querySelector('#plist').textContent.includes('Mel por unidade') && !document.querySelector('#psave').disabled");
    const unitId = db.prepare("SELECT id FROM products WHERE name='Mel por unidade'").get().id;
    assert.equal(db.prepare('SELECT stock_units FROM products WHERE id=?').get(unitId).stock_units, 6);
    await evaluate(`document.querySelector('#plist [data-e="${unitId}"]').click();`);
    assert.equal(await evaluate("document.querySelector('#psale-unit').value"), 'unit');
    assert.equal(await evaluate("document.querySelector('#pstock').value"), '6');
    await evaluate("document.querySelector('#psale-unit').value='weight';document.querySelector('#psale-unit').dispatchEvent(new Event('change'));");
    assert.equal(await evaluate("document.querySelector('#pstock').value"), '0', 'Unit stock must not be interpreted as grams when changing methods');
    await evaluate("document.querySelector('#psale-unit').value='unit';document.querySelector('#psale-unit').dispatchEvent(new Event('change'));");
    assert.equal(await evaluate("document.querySelector('#pstock').value"), '6');
    await screenshot('units-admin-mobile.png');

    // The kit editor hides weight for a unit product and prices mixed components.
    await evaluate(`document.querySelector('.tabs [data-t="kt"]').click();`);
    await waitFor(`document.querySelector('.kit-component select option[value="${unitId}"]')`);
    await evaluate(`document.querySelector('#kit-reset').click();document.querySelector('#kit-name').value='Kit misto';const first=document.querySelector('.kit-component');first.querySelector('select').value='${unitId}';first.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}));first.querySelector('[data-kit-qty]').value='2';document.querySelector('#kit-add-component').click();const second=document.querySelectorAll('.kit-component')[1];second.querySelector('select').value='1';second.querySelector('[data-kit-weight]').value='100';second.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}));`);
    assert.equal(await evaluate("document.querySelector('[data-kit-weight-label]').hidden"), true);
    assert.match(await evaluate("document.querySelector('#kit-price-preview').textContent"), /31,00/);
    await evaluate("document.querySelector('#kit-form').requestSubmit();");
    await waitFor("document.querySelector('#kit-list').textContent.includes('Kit misto')");
    const mixedKitId = db.prepare("SELECT id FROM kits WHERE name='Kit misto'").get().id;

    await command('Page.navigate', { url: site });
    await waitFor(`document.querySelector('[data-product="${unitId}"] [data-unit-quantity]')`);
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-product="${unitId}"] [data-weight]'))`), false);
    await evaluate(`document.querySelector('[data-product="${unitId}"] [data-unit-step="-"]').click()`);
    assert.equal(await evaluate(`document.querySelector('[data-product="${unitId}"] [data-unit-quantity]').value`), '0');
    assert.equal(await evaluate(`document.querySelector('[data-product="${unitId}"] [data-add]').disabled`), true);
    await evaluate(`for(let i=0;i<7;i++) document.querySelector('[data-product="${unitId}"] [data-unit-step="+"]').click()`);
    assert.equal(await evaluate(`document.querySelector('[data-product="${unitId}"] [data-unit-quantity]').value`), '6');
    assert.equal(await evaluate(`document.querySelector('[data-product="${unitId}"] [data-unit-step="+"]').disabled`), true);
    assert.match(await evaluate(`document.querySelector('[data-product="${unitId}"] [data-portion-price]').textContent`), /75,00/);
    await evaluate(`document.querySelector('[data-product="${unitId}"] [data-unit-step="-"]').click();const increase=document.querySelector('[data-product="${unitId}"] [data-unit-step="+"]');increase.focus();checkPromotion()`);
    assert.equal(await evaluate('document.activeElement.dataset.unitStep'), '+', 'Catalog refresh preserves stepper focus');
    for (const width of [360,390,430,768,1024,1440]) {
      await command('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:width<768});
      for(const theme of ['light','dark']) {
        await evaluate(`localStorage.setItem('puro-theme','${theme}');window.dispatchEvent(new StorageEvent('storage',{key:'puro-theme'}));document.querySelector('[data-product="${unitId}"]').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>setTimeout(resolve,150))`);
        const sizes = await evaluate(`(() => {const control=document.querySelector('[data-product="${unitId}"] .unit-stepper');return {input:control.querySelector('input').clientWidth,compact:Boolean(control.closest('.catalog-carousel-track')),coarsePointer:matchMedia('(pointer:coarse)').matches,buttons:[...control.querySelectorAll('button')].map(button=>({width:button.clientWidth,height:button.clientHeight,outerWidth:button.getBoundingClientRect().width,outerHeight:button.getBoundingClientRect().height})),overflow:document.documentElement.scrollWidth>innerWidth};})()`);
        assert.ok(sizes.input>=30,'The numeric quantity must fit in the central box');
        const minCompactHeight = sizes.coarsePointer ? 36 : 32;
        assert.ok(sizes.buttons.every(button=>sizes.compact?button.outerWidth>=minCompactHeight&&button.outerHeight>=minCompactHeight:button.width>=42&&button.height>=42),'Stepper buttons fit the catalog layout and pointer type');
        assert.equal(sizes.overflow,false);
        if([390,1440].includes(width)) {
          const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
          fs.writeFileSync(path.join(artifacts,`unit-stepper-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
        }
      }
    }
    console.log('Unit stepper passed: zero selection, stock limit, live price, refresh focus and six viewport widths in both themes.');
    await evaluate(`const card=document.querySelector('[data-product="${unitId}"]');const quantity=card.querySelector('[data-unit-quantity]');quantity.value='3';quantity.dispatchEvent(new Event('input',{bubbles:true}));`);
    assert.match(await evaluate(`document.querySelector('[data-product="${unitId}"] [data-portion-price]').textContent`), /37,50/);
    const unitShare = new URL(await evaluate(`document.querySelector('[data-product="${unitId}"] [data-share-product]').href`)).searchParams.get('text');
    assert.match(unitShare, /12,50 por 1 unidade/);
    await evaluate(`document.querySelector('[data-product="${unitId}"] [data-add]').click();document.querySelector('[data-product="1"] [data-add]').click();document.querySelector('#cartBtn').click();`);
    assert.match(await evaluate("document.querySelector('#items').textContent"), /3 unidades/);
    assert.match(await evaluate("document.querySelector('#items').textContent"), /100 g por porção/);
    const mixedCart = await evaluate("JSON.parse(localStorage.getItem('puro-cart-weight-v1'))");
    assert.equal(mixedCart[`${unitId}:unit`].qty, 3);
    assert.equal(mixedCart['1:100'].qty, 1);
    await evaluate(`document.querySelector('#items [data-key="${unitId}:unit"][data-action="+"]').click();`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('puro-cart-weight-v1'))['${unitId}:unit'].qty`), 4);
    for (const width of [1440, 390, 320]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
      await evaluate('new Promise(resolve=>setTimeout(resolve,300))');
      assert.equal(await evaluate('document.documentElement.scrollWidth'), width);
      const drawerBounds = await evaluate("({left:document.querySelector('#drawer').getBoundingClientRect().left,right:document.querySelector('#drawer').getBoundingClientRect().right})");
      assert.ok(drawerBounds.left >= 0 && Math.abs(drawerBounds.right-width) < 1, 'Open cart must fit inside the viewport');
      if (width === 390) {
        await evaluate("document.querySelector('#toast').hidden=true;");
        const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(path.join(artifacts, 'units-cart-mobile.png'), Buffer.from(data, 'base64'));
      }
    }
    await evaluate(`document.querySelector('#closeCart').click();localStorage.setItem('puro-cart-weight-v1','{}');window.dispatchEvent(new StorageEvent('storage',{key:'puro-cart-weight-v1'}));document.querySelector('[data-add-kit="${mixedKitId}"]').click();`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('puro-cart-weight-v1'))['${unitId}:unit'].qty`), 2);
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('puro-cart-weight-v1'))['1:100'].qty"), 1);
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`document.querySelector('[data-product="${unitId}"]').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>setTimeout(resolve,150));`);
    const { data: unitCardShot } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(artifacts, 'units-store-mobile.png'), Buffer.from(unitCardShot, 'base64'));

    // Redesign checks exercise the existing controls; every fixture stays in preview.db.
    const viewportShot = async name => {
      await evaluate("document.querySelector('#toast')?.setAttribute('hidden','');document.activeElement?.blur();");
      await evaluate('new Promise(resolve=>setTimeout(resolve,250))');
      const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(artifacts, name), Buffer.from(data, 'base64'));
    };
    const setTheme = async theme => {
      await evaluate(`localStorage.setItem('puro-theme','${theme}');window.dispatchEvent(new StorageEvent('storage',{key:'puro-theme'}));`);
      assert.equal(await evaluate('document.documentElement.dataset.theme'), theme);
    };
    const fitViewport = async (width, label) => {
      const bounds = await evaluate('({viewport:innerWidth,width:document.documentElement.scrollWidth})');
      const overflow = bounds.width > width ? await evaluate("[...document.querySelectorAll('body *')].filter(el=>el.getClientRects().length&&el.getBoundingClientRect().right>innerWidth+1).slice(-12).map(el=>({tag:el.tagName,id:el.id,class:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right}))") : [];
      assert.ok(bounds.width <= width, label + ': horizontal overflow ' + JSON.stringify(overflow));
      assert.equal(bounds.viewport, width);
    };
    await evaluate("document.querySelector('#clearCart').click();");
    assert.equal(await evaluate("document.querySelector('#cc').textContent"), '0');
    assert.equal(await evaluate("document.querySelector('#cart-actions').hidden"), true);
    assert.deepEqual(await evaluate("JSON.parse(localStorage.getItem('puro-cart-weight-v1'))"), {});
    db.prepare('UPDATE products SET is_new=1,tuesday_promo=1 WHERE id=1').run();
    const sampleOrder = await (await fetch(site + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer: 'Cliente do teste visual', items: [{ id: 1, weight_grams: 100, qty: 1 }] }) })).json();
    const previewToken = (await (await fetch(site + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'preview-only-password' }) })).json()).token;
    assert.equal((await fetch(site + `/api/admin/orders/${sampleOrder.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-token': previewToken }, body: JSON.stringify({ status: 'pago' }) })).status, 200);
    await evaluate('checkPromotion()');
    assert.equal(await evaluate("document.querySelector('#best-sellers-section').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#new-products-section').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#kits-prontos').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#ofertas').hidden"), true, 'Tuesday discounts must remain inactive on Wednesday');

    const imageCartBefore = await evaluate("localStorage.getItem('puro-cart-weight-v1')");
    for (const width of [360, 390, 430, 768, 1024, 1440]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await evaluate("document.querySelector('[data-product=\"1\"] [data-open-product-image]').focus();");
        if (width === 390 && theme === 'light') {
          await command('Emulation.setTouchEmulationEnabled', { enabled: true });
          await evaluate("document.querySelector('[data-product=\"1\"] [data-open-product-image]').scrollIntoView({block:'center',behavior:'instant'});");
          await waitFor("(() => {const box=document.querySelector('[data-product=\"1\"] [data-open-product-image]').getBoundingClientRect();return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('[data-product=\"1\"] [data-open-product-image]');})()");
          const point = await evaluate("(() => {const box=document.querySelector('[data-product=\"1\"] [data-open-product-image]').getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};})()");
          await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
          await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await command('Emulation.setTouchEmulationEnabled', { enabled: false });
        } else {
          await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        }
        await waitFor("document.querySelector('#product-image-dialog').open && !document.querySelector('#product-image-dialog img').hidden");
        const imageView = await evaluate(`(() => {
          const dialog=document.querySelector('#product-image-dialog'), image=dialog.querySelector('img'), box=dialog.getBoundingClientRect();
          return {sameSource:image.src===document.querySelector('[data-product="1"] .product-photo').src,name:document.querySelector('#product-image-title').textContent,alt:image.alt,fit:getComputedStyle(image).objectFit,fits:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,focus:dialog.contains(document.activeElement)};
        })()`);
        assert.equal(imageView.sameSource, true);
        assert.equal(imageView.name, imageView.alt);
        assert.equal(imageView.fit, 'contain');
        assert.equal(imageView.fits, true, `Enlarged image must fit ${width}px in ${theme}`);
        assert.equal(imageView.focus, true);
        if ([390, 1440].includes(width)) await viewportShot(`product-image-${theme}-${width}.png`);
        await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await waitFor("!document.querySelector('#product-image-dialog').open && document.activeElement.matches('[data-product=\"1\"] [data-open-product-image]') && !document.body.classList.contains('ui-dialog-open')");
      }
    }
    await evaluate("document.querySelector('.highlight-card[data-choose-product=\"1\"] .product-photo').click();");
    await waitFor("document.querySelector('#product-image-dialog').open && !document.querySelector('#product-image-dialog img').hidden");
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 });
    await waitFor("!document.querySelector('#product-image-dialog').open");
    assert.equal(await evaluate("localStorage.getItem('puro-cart-weight-v1')"), imageCartBefore);
    await evaluate("document.querySelector('.highlight-card[data-choose-product=\"1\"] .highlight-info').click();");
    assert.equal(await evaluate("document.activeElement.id"), 'product-1', 'The shelf purchase link must still focus the product');
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor("document.querySelector('.filters').parentElement.className==='filter-dialog-slot'");
    console.log('Product images passed: catalog and shelves, portrait and landscape, touch, keyboard, close button, Escape, backdrop, restored focus, unchanged cart and six widths in both themes.');

    // One category list lives in the catalog; icons use the original filter handlers.
    assert.equal(await evaluate("document.querySelector('#category-cards, .category-section, [data-category-link]')"), null);
    assert.equal(await evaluate("document.querySelectorAll('.filters').length"), 1);
    assert.equal(await evaluate("document.querySelector('#produtos').contains(document.querySelector('#categorias'))"), true);
    assert.ok(await evaluate("[...document.querySelectorAll('.filters [data-category]')].every(button=>button.querySelectorAll('svg').length===1 && button.querySelector('.category-label').textContent===button.dataset.category)"));
    await evaluate("document.querySelector('.filters [data-category=\"Grãos\"] svg').dispatchEvent(new MouseEvent('click',{bubbles:true}));");
    assert.equal(await evaluate("document.querySelector('.filters [data-category=\"Grãos\"]').getAttribute('aria-pressed')"), 'true');
    assert.ok(await evaluate("[...document.querySelectorAll('.card:not([hidden])')].every(card=>card.querySelector('.product-category').textContent==='Grãos')"));
    await evaluate('loadCatalog()');
    assert.equal(await evaluate("document.querySelector('.filters [data-category=\"Grãos\"]').getAttribute('aria-pressed')"), 'true');
    assert.ok(await evaluate("[...document.querySelectorAll('.filters [data-category]')].every(button=>button.querySelectorAll('svg').length===1)"));
    await evaluate("document.querySelector('[data-clear-filters]').click();");
    assert.equal(await evaluate("document.querySelectorAll('.card:not([hidden])').length"), 12);
    await evaluate("document.querySelector('[data-open-filters]').click();");
    assert.equal(await evaluate("document.querySelector('#filter-dialog').open"), true);
    assert.equal(await evaluate("document.querySelector('.filters').parentElement.className"), 'filter-dialog-slot');
    await evaluate("document.querySelector('#search').value='hibisco';document.querySelector('#search').dispatchEvent(new Event('input'));document.querySelector('.filters [data-category=\"Chás\"] svg').dispatchEvent(new MouseEvent('click',{bubbles:true}));");
    await waitFor("!document.querySelector('#filter-dialog').open && document.activeElement.matches('#grid .card:not([hidden])')");
    await waitFor("document.querySelector('#grid .card:not([hidden])').getBoundingClientRect().top>=document.querySelector('.store-header').getBoundingClientRect().bottom && document.querySelector('#grid .card:not([hidden])').getBoundingClientRect().top<180");
    assert.equal(await evaluate("document.querySelectorAll('#grid .card:not([hidden])').length"), 1);
    assert.equal(await evaluate("document.querySelector('#search').value"), 'hibisco');
    assert.equal(await evaluate("document.querySelector('[data-open-filters]').getAttribute('aria-expanded')"), 'false');
    await evaluate("document.querySelector('[data-open-filters]').click();document.querySelector('.filters [data-category=\"Todos\"]').focus();");
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor("!document.querySelector('#filter-dialog').open && document.querySelector('.filters [data-category=\"Todos\"]').getAttribute('aria-pressed')==='true'");
    assert.equal(await evaluate("document.querySelector('#search').value"), 'hibisco');
    await evaluate("document.querySelector('[data-clear-filters]').click();document.querySelector('[data-open-menu]').click();");
    assert.equal(await evaluate("document.querySelector('#mobile-menu').open"), true);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor("!document.querySelector('#mobile-menu').open");
    assert.equal(await evaluate("document.activeElement.matches('[data-open-menu]')"), true);

    // Category carousels reuse the catalog cards. All extra products exist only in browser memory.
    const carouselCatalog = await (await fetch(site + '/api/products')).json();
    const carouselFixture = structuredClone(carouselCatalog);
    const carouselWeightSource = carouselCatalog.products.find(product => product.sale_unit !== 'unit' && product.stock_grams > 1000);
    const carouselUnitSource = carouselCatalog.products.find(product => product.sale_unit === 'unit' && product.stock_units > 2);
    assert.ok(carouselWeightSource && carouselUnitSource, 'Carousel checks need both existing selling methods');
    const carouselExtraProducts = Array.from({ length: 10 }, (_, index) => ({
      ...carouselWeightSource, id: 100001 + index,
      name: index === 0 ? 'Chá carrossel' : index === 1 ? 'Chá carrossel de camomila com erva-doce e folhas selecionadas' : `Chá carrossel ${String(index + 1).padStart(2, '0')}`,
      description: index === 2 ? 'Flores e folhas selecionadas para preparar uma infusão aromática. Escolha o peso desejado e consulte as orientações da embalagem para o preparo.' : index === 3 ? '  \n\t  ' : carouselWeightSource.description,
      category: 'Chás', best_seller_rank: 0, is_new: index === 9 ? 1 : 0, tuesday_promo: 0, discount_percent: 0,
    }));
    carouselExtraProducts.push({ ...carouselUnitSource, id: 100011, name: 'Chá carrossel por unidade', category: 'Chás', best_seller_rank: 0, is_new: 0, tuesday_promo: 0, discount_percent: 0 });
    carouselFixture.products.push(...carouselExtraProducts);
    const carouselCategoryIds = carouselFixture.products.filter(product => product.category === 'Chás').map(product => product.id);
    const carouselPageBefore = await evaluate('location.href');
    const carouselCartBefore = await evaluate("localStorage.getItem('puro-cart-weight-v1')");
    const carouselThemeBefore = await evaluate('document.documentElement.dataset.theme');
    const carouselTrack = "document.querySelector('.catalog-category-row[data-catalog-category=\"Chás\"] .catalog-carousel-track')";
    const carouselRow = "document.querySelector('.catalog-category-row[data-catalog-category=\"Chás\"]')";
    const carouselNodesPreserved = "window.__carouselNodes.every(card=>document.querySelector('#product-'+card.dataset.product)===card)";
    try {
      await evaluate(`loadCatalog(${JSON.stringify(carouselFixture)})`);
      await evaluate('clearTimeout(promotionTimer)');
      await waitFor("document.querySelector('#grid').classList.contains('catalog-rows') && document.querySelectorAll('.catalog-category-row').length>0");
      const groupedCategories = await evaluate("[...document.querySelectorAll('#grid > .catalog-category-row')].map(row=>({name:row.dataset.catalogCategory,title:row.querySelector('h3').textContent,ids:[...row.querySelectorAll('.catalog-carousel-track > .card')].map(card=>Number(card.dataset.product))}))");
      assert.deepEqual(groupedCategories.map(row => row.name).sort(), [...new Set(carouselFixture.products.map(product => product.category))].sort());
      for (const row of groupedCategories) {
        assert.ok(row.title.includes(row.name), 'Each row names its category');
        assert.deepEqual(row.ids, carouselFixture.products.filter(product => product.category === row.name).map(product => product.id), 'Manual product order remains intact within each category');
      }
      assert.equal(await evaluate("document.querySelectorAll('#grid .card').length"), carouselFixture.products.length);
      assert.equal(await evaluate("document.querySelectorAll('#grid .product-description[open]').length"), 0, 'Product descriptions start collapsed');
      assert.equal(await evaluate("document.querySelector('#product-100004 [data-description-toggle]')"), null, 'A whitespace-only description has no disclosure control');
      assert.ok(await evaluate("[...document.querySelectorAll('#grid [data-description-toggle]')].every(summary=>summary.tagName==='SUMMARY'&&summary.parentElement.tagName==='DETAILS'&&summary.querySelector('.description-show').checkVisibility()&&!summary.querySelector('.description-hide').checkVisibility())"), 'Descriptions use native disclosures with a visible show label');
      assert.ok(await evaluate("(() => {const ids=[...document.querySelectorAll('#grid [id]')].map(node=>node.id);return new Set(ids).size===ids.length;})()"), 'Grouping must never clone product or control IDs');
      assert.ok(await evaluate("[...document.querySelectorAll('.catalog-category-row [data-carousel-direction]')].every(button=>button.tagName==='BUTTON' && button.getAttribute('aria-label') && document.getElementById(button.getAttribute('aria-controls'))===button.closest('.catalog-category-row').querySelector('.catalog-carousel-track'))"), 'Carousel arrows identify the track they control');
      await evaluate("(() => {window.__carouselNodes=[...document.querySelectorAll('#grid .card')];document.querySelector('[data-product=\"100001\"] [data-weight=\"custom\"]').click();const weight=document.querySelector('[data-product=\"100001\"] [data-custom-weight]');weight.value='333';weight.dispatchEvent(new Event('input',{bubbles:true}));const quantity=document.querySelector('[data-product=\"100011\"] [data-unit-quantity]');quantity.value='2';quantity.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-product=\"1\"] [data-add]').click();})()");
      const carouselCartWithProduct = await evaluate("localStorage.getItem('puro-cart-weight-v1')");
      assert.notEqual(carouselCartWithProduct, carouselCartBefore, 'A real existing product can still be added from its category row');
      await evaluate("document.querySelector('#product-100003 [data-description-toggle]').click();");
      await evaluate("document.querySelector('.filters [data-category=\"Chás\"]').click();");
      await waitFor("!document.querySelector('#grid').classList.contains('catalog-rows')");
      assert.deepEqual(await evaluate("[...document.querySelectorAll('#grid > .card:not([hidden])')].map(card=>Number(card.dataset.product))"), carouselCategoryIds, 'A specific category retains the normal filtered grid');
      assert.deepEqual(await evaluate("[...document.querySelectorAll('#grid > .card')].map(card=>Number(card.dataset.product))"), carouselFixture.products.map(product => product.id), 'Flattening restores the original manual order');
      assert.equal(await evaluate(carouselNodesPreserved), true, 'Category filtering moves the same card nodes');
      assert.equal(await evaluate("document.querySelector('#product-100003 .product-description').open"), true, 'A category filter preserves the expanded description');
      await evaluate("document.querySelector('[data-clear-filters]').click();document.querySelector('#search').value='carrossel';document.querySelector('#search').dispatchEvent(new Event('input'));");
      await waitFor("!document.querySelector('#grid').classList.contains('catalog-rows')");
      assert.deepEqual(await evaluate("[...document.querySelectorAll('#grid > .card')].map(card=>Number(card.dataset.product))"), carouselFixture.products.map(product => product.id), 'Search restores the complete source order before hiding nonmatches');
      assert.deepEqual(await evaluate("[...document.querySelectorAll('#grid > .card:not([hidden])')].map(card=>Number(card.dataset.product))"), carouselExtraProducts.map(product => product.id), 'Search results remain a single grid');
      assert.equal(await evaluate(carouselNodesPreserved), true);
      assert.equal(await evaluate("document.querySelector('#product-100003 .product-description').open"), true, 'Search preserves the expanded description');
      await evaluate("document.querySelector('#search').value='   ';document.querySelector('#search').dispatchEvent(new Event('input'));");
      await waitFor("document.querySelector('#grid').classList.contains('catalog-rows')");
      assert.equal(await evaluate(carouselNodesPreserved), true, 'Returning to all products preserves the same controls');
      assert.equal(await evaluate("document.querySelector('[data-product=\"100001\"] [data-custom-weight]').value"), '333');
      assert.equal(await evaluate("document.querySelector('[data-product=\"100001\"] [data-weight=\"custom\"]').getAttribute('aria-pressed')"), 'true');
      assert.equal(await evaluate("document.querySelector('[data-product=\"100011\"] [data-unit-quantity]').value"), '2');
      assert.equal(await evaluate("localStorage.getItem('puro-cart-weight-v1')"), carouselCartWithProduct, 'Grouping, category filters and search leave the cart intact');
      await evaluate("document.querySelector('#search').value='';document.querySelector('#search').dispatchEvent(new Event('input'));document.querySelector('#product-100003 [data-description-toggle]').click();");

      for (const width of [360, 390, 430, 768, 1024, 1440]) {
        await command('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 768 });
        for (const theme of ['light', 'dark']) {
          await setTheme(theme);
          await evaluate(`${carouselRow}.scrollIntoView({block:'start',behavior:'instant'});${carouselTrack}.scrollTo({left:0,behavior:'instant'});`);
          await waitFor(`${carouselRow}.querySelector('[data-carousel-direction="previous"]').disabled && !${carouselRow}.querySelector('[data-carousel-direction="next"]').disabled`);
          const trackBounds = await evaluate(`(() => {const track=${carouselTrack},box=track.getBoundingClientRect();return {overflow:track.scrollWidth>track.clientWidth,left:box.left,right:box.right,cards:[...track.children].every(card=>card.getBoundingClientRect().width<=track.clientWidth+1)};})()`);
          assert.equal(trackBounds.overflow, true, `The fixture must exercise horizontal movement at ${width}px`);
          assert.ok(trackBounds.left >= 0 && trackBounds.right <= width + 1 && trackBounds.cards, `The row and each card fit ${theme} ${width}`);
          const alignmentExpression = `(() => {
            const track=${carouselTrack};
            const cards=[...track.children].map(card=>({height:card.offsetHeight,buttonTop:card.querySelector('[data-add]').getBoundingClientRect().top-card.getBoundingClientRect().top}));
            const textFits=selector=>{const element=document.querySelector(selector),range=document.createRange();range.selectNodeContents(element);const text=range.getBoundingClientRect(),box=element.getBoundingClientRect();return text.top>=box.top-1&&text.bottom<=box.bottom+1&&text.width<=box.width+1;};
            const details=document.querySelector('#product-100003 .product-description');
            return {heights:cards.map(card=>card.height),buttons:cards.map(card=>card.buttonTop),fullName:textFits('#product-100002 h3'),fullDescription:details.open&&textFits('#product-100003 .description'),customVisible:document.querySelector('#product-100001 .custom-weight').checkVisibility(),open:details.open,show:details.querySelector('.description-show').checkVisibility(),hide:details.querySelector('.description-hide').checkVisibility()};
          })()`;
          const collapsedAlignment = await evaluate(alignmentExpression);
          assert.equal(collapsedAlignment.open, false);
          assert.ok(collapsedAlignment.show&&!collapsedAlignment.hide, `The closed description offers a clear show label at ${theme} ${width}`);
          await evaluate("document.querySelector('#product-100003 [data-description-toggle]').click();");
          const expandedAlignment = await evaluate(alignmentExpression);
          assert.equal(expandedAlignment.open, true);
          assert.ok(expandedAlignment.fullDescription&&!expandedAlignment.show&&expandedAlignment.hide, `Opening reveals the complete description and hide label at ${theme} ${width}`);
          for (const [state, alignment] of [['collapsed',collapsedAlignment],['expanded',expandedAlignment]]) {
            assert.ok(Math.max(...alignment.heights)-Math.min(...alignment.heights)<=1, `Short names, long names, ${state} descriptions, custom weights and units keep equal card heights at ${theme} ${width}`);
            assert.ok(Math.max(...alignment.buttons)-Math.min(...alignment.buttons)<=1, `Add buttons align with ${state} descriptions at ${theme} ${width}`);
            assert.ok(alignment.fullName&&alignment.customVisible, `Complete names and the selected custom weight stay visible at ${theme} ${width}`);
          }
          await evaluate("document.querySelector('#product-100003 [data-description-toggle]').click();");
          const closedHeight = await evaluate("document.querySelector('#product-100003').offsetHeight");
          assert.ok(closedHeight<expandedAlignment.heights[0], `Closing the description reduces the row height at ${theme} ${width}`);
          assert.equal(closedHeight, collapsedAlignment.heights[0], 'The disclosure returns to its original compact height');
          assert.equal(await evaluate("document.querySelector('[data-product=\"100001\"] [data-custom-weight]').value"), '333');
          assert.equal(await evaluate("document.querySelector('[data-product=\"100011\"] [data-unit-quantity]').value"), '2');
          assert.equal(await evaluate("localStorage.getItem('puro-cart-weight-v1')"), carouselCartWithProduct, 'Description toggles do not affect the cart');
          await fitViewport(width, `Category carousels ${theme} ${width}`);
          await evaluate(`${carouselRow}.querySelector('[data-carousel-direction="next"]').click();`);
          await waitFor(`${carouselTrack}.scrollLeft>20 && !${carouselRow}.querySelector('[data-carousel-direction="previous"]').disabled`);
          await evaluate(`${carouselRow}.querySelector('[data-carousel-direction="previous"]').click();`);
          await waitFor(`${carouselTrack}.scrollLeft<=1 && ${carouselRow}.querySelector('[data-carousel-direction="previous"]').disabled`);
          await evaluate(`${carouselTrack}.scrollTo({left:${carouselTrack}.scrollWidth,behavior:'instant'});`);
          await waitFor(`${carouselRow}.querySelector('[data-carousel-direction="next"]').disabled && !${carouselRow}.querySelector('[data-carousel-direction="previous"]').disabled`);
          await evaluate(`${carouselTrack}.scrollTo({left:0,behavior:'instant'});`);
          if ([390, 1440].includes(width)) await viewportShot(`catalog-carousels-${theme}-${width}.png`);
        }
      }

      // Native details support real keyboard activation and taps without changing purchase controls.
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await evaluate("document.querySelector('#product-100003 [data-description-toggle]').focus();");
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await waitFor("document.querySelector('#product-100003 .product-description').open");
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', unmodifiedText: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
      await waitFor("!document.querySelector('#product-100003 .product-description').open");
      await evaluate("document.querySelector('#product-100003 [data-description-toggle]').scrollIntoView({block:'center',inline:'center',behavior:'instant'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));");
      const descriptionTap = await evaluate("(() => {const summary=document.querySelector('#product-100003 [data-description-toggle]'),box=summary.getBoundingClientRect(),point={x:box.x+box.width/2,y:box.y+box.height/2};return {...point,hit:document.elementFromPoint(point.x,point.y)?.closest('summary')===summary};})()");
      assert.equal(descriptionTap.hit, true, 'The description control is a visible mobile tap target');
      await command('Emulation.setTouchEmulationEnabled', { enabled: true });
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: descriptionTap.x, y: descriptionTap.y, id: 1 }] });
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await command('Emulation.setTouchEmulationEnabled', { enabled: false });
      await waitFor("document.querySelector('#product-100003 .product-description').open");
      await evaluate("document.querySelector('#product-100003 [data-description-toggle]').focus();");
      await evaluate(`loadCatalog(${JSON.stringify(carouselFixture)})`);
      await evaluate('clearTimeout(promotionTimer)');
      await waitFor("document.querySelector('#product-100003 .product-description').open&&document.activeElement===document.querySelector('#product-100003 [data-description-toggle]')");
      assert.equal(await evaluate("document.querySelector('[data-product=\"100001\"] [data-custom-weight]').value"), '333', 'Refreshing an expanded description preserves the custom weight');
      assert.equal(await evaluate("document.querySelector('[data-product=\"100011\"] [data-unit-quantity]').value"), '2', 'Refreshing an expanded description preserves unit selection');
      assert.equal(await evaluate("localStorage.getItem('puro-cart-weight-v1')"), carouselCartWithProduct, 'Keyboard, touch and refresh leave the cart intact');
      await evaluate("document.querySelector('#product-100003 [data-description-toggle]').click();");

      // Focusing a clicked control must not move a partially visible card between press and release.
      for (const width of [1440, 390]) {
        await command('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 768 });
        const partialCardClick = await evaluate(`(async () => {
          const track=${carouselTrack},card=document.querySelector('#product-100005'),button=card.querySelector('[data-weight="100"]');
          document.activeElement?.blur();card.querySelector('[data-weight="250"]').click();
          window.__carouselSnapBefore=track.style.scrollSnapType;track.style.scrollSnapType='none';
          const frame=track.getBoundingClientRect(),control=button.getBoundingClientRect();
          track.scrollTo({left:track.scrollLeft+control.right-frame.right+16,behavior:'instant'});
          scrollBy({top:button.getBoundingClientRect().top-innerHeight/2,behavior:'instant'});
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const box=button.getBoundingClientRect(),item=card.getBoundingClientRect(),clip=track.getBoundingClientRect();
          const point={x:box.x+box.width/2,y:box.y+box.height/2};
          return {...point,scroll:track.scrollLeft,partial:item.left<clip.right&&item.right>clip.right+20,hit:document.elementFromPoint(point.x,point.y)?.closest('button')===button};
        })()`);
        assert.equal(partialCardClick.partial, true, `The next product must actually be clipped at ${width}px`);
        assert.equal(partialCardClick.hit, true, `The weight button is visibly clickable at ${width}px`);
        if (width === 1440) {
          await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: partialCardClick.x, y: partialCardClick.y });
          await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: partialCardClick.x, y: partialCardClick.y, button: 'left', clickCount: 1 });
          const pressStillHitsButton = await evaluate(`document.elementFromPoint(${partialCardClick.x},${partialCardClick.y})?.closest('button')===document.querySelector('#product-100005 [data-weight="100"]')`);
          await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: partialCardClick.x, y: partialCardClick.y, button: 'left', clickCount: 1 });
          assert.equal(pressStillHitsButton, true, 'Mouse focus must not move the button before release');
        } else {
          await command('Emulation.setTouchEmulationEnabled', { enabled: true });
          await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: partialCardClick.x, y: partialCardClick.y, id: 1 }] });
          await new Promise(resolve => setTimeout(resolve, 30));
          await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await command('Emulation.setTouchEmulationEnabled', { enabled: false });
        }
        await waitFor("document.querySelector('#product-100005 [data-weight=\"100\"]').getAttribute('aria-pressed')==='true'");
        assert.ok(Math.abs(await evaluate(`${carouselTrack}.scrollLeft`) - partialCardClick.scroll) <= 1, `A ${width < 768 ? 'touch' : 'mouse'} weight selection must not unexpectedly slide the row`);
        await evaluate(`${carouselTrack}.style.scrollSnapType=window.__carouselSnapBefore;delete window.__carouselSnapBefore;`);
      }

      // Real touch input must pan the track without moving the page sideways or opening a photo.
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await evaluate(`${carouselRow}.scrollIntoView({block:'start',behavior:'instant'});${carouselTrack}.scrollTo({left:0,behavior:'instant'});`);
      await waitFor(`${carouselTrack}.scrollLeft<=1`);
      await command('Emulation.setTouchEmulationEnabled', { enabled: true });
      const swipePoint = await evaluate(`(() => {const box=${carouselTrack}.getBoundingClientRect();return {x:Math.min(box.right-24,innerWidth-24),y:Math.max(box.top+60,140)};})()`);
      assert.equal(await evaluate(`Boolean(document.elementFromPoint(${swipePoint.x},${swipePoint.y})?.closest('.catalog-carousel-track'))`), true, 'The swipe begins inside a visible product row');
      await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...swipePoint, id: 1 }] });
      for (let step = 1; step <= 8; step++) {
        await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipePoint.x - step * 32, y: swipePoint.y, id: 1 }] });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await command('Emulation.setTouchEmulationEnabled', { enabled: false });
      await waitFor(`${carouselTrack}.scrollLeft>30`);
      assert.equal(await evaluate("document.querySelector('#product-image-dialog').open"), false, 'Dragging a product photo must not open the image viewer');
      await fitViewport(390, 'Real mobile category swipe');

      // Shelf links and catalog refreshes must reveal a product beyond the visible part of its row.
      await evaluate(`${carouselTrack}.scrollTo({left:0,behavior:'instant'});`);
      assert.ok(await evaluate("document.querySelector('#product-100010').getBoundingClientRect().left>=innerWidth"), 'The linked product starts outside the visible row');
      await evaluate("document.querySelector('.highlight-card[data-choose-product=\"100010\"] .highlight-info').click();");
      try {
        await waitFor(`(() => {const card=document.querySelector('#product-100010'),box=card.getBoundingClientRect(),track=${carouselTrack}.getBoundingClientRect();return document.activeElement===card&&box.left>=track.left-1&&box.right<=track.right+1;})()`);
      } catch (error) {
        console.log('Carousel focus diagnostic:', await evaluate(`(() => {const card=document.querySelector('#product-100010'),box=card.getBoundingClientRect(),track=${carouselTrack};return {active:document.activeElement.id,tag:document.activeElement.tagName,hash:location.hash,card:{left:box.left,right:box.right,top:box.top},track:{left:track.getBoundingClientRect().left,right:track.getBoundingClientRect().right,scrollLeft:track.scrollLeft,scrollWidth:track.scrollWidth,clientWidth:track.clientWidth},pointerFocusing:undefined};})()`));
        throw error;
      }
      await evaluate("document.querySelector('#product-100010 [data-weight=\"250\"]').focus();");
      await evaluate(`loadCatalog(${JSON.stringify(carouselFixture)})`);
      await evaluate('clearTimeout(promotionTimer)');
      await waitFor(`(() => {const control=document.querySelector('#product-100010 [data-weight="250"]'),box=control.closest('.card').getBoundingClientRect(),track=${carouselTrack}.getBoundingClientRect();return document.activeElement===control&&box.left>=track.left-1&&box.right<=track.right+1;})()`);
      assert.equal(await evaluate("document.querySelector('[data-product=\"100001\"] [data-custom-weight]').value"), '333', 'A catalog refresh retains weight selection');
      assert.equal(await evaluate("document.querySelector('[data-product=\"100011\"] [data-unit-quantity]').value"), '2', 'A catalog refresh retains unit selection');
      assert.equal(await evaluate("localStorage.getItem('puro-cart-weight-v1')"), carouselCartWithProduct);
    } finally {
      await command('Emulation.setTouchEmulationEnabled', { enabled: false });
      await evaluate(`history.replaceState(null,'',${JSON.stringify(carouselPageBefore)});localStorage.setItem('puro-cart-weight-v1',${JSON.stringify(carouselCartBefore)});window.dispatchEvent(new StorageEvent('storage',{key:'puro-cart-weight-v1'}));document.querySelector('#search').value='';document.querySelector('[data-clear-filters]').click();`);
      await evaluate(`loadCatalog(${JSON.stringify(carouselCatalog)})`);
      await evaluate(`delete window.__carouselNodes;${JSON.stringify(carouselExtraProducts.map(product => product.id))}.forEach(id=>selections.delete(id));`);
      await setTheme(carouselThemeBefore);
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await waitFor("document.querySelector('.filters').parentElement.className==='filter-dialog-slot'");
    }
    assert.equal(await evaluate("localStorage.getItem('puro-cart-weight-v1')"), carouselCartBefore);
    console.log('Category carousels passed: original card identity/order, category and search grids, compact native description disclosures, keyboard/touch/refresh, equal card heights and aligned actions with complete text, weights/units/cart, accessible arrows, edge states, mouse/touch on clipped cards, real mobile swipe, offscreen product links, refresh focus and six widths in both themes.');

    // Verify the six requested widths and both token sets on the Home and cart.
    for (const width of [360, 390, 430, 768, 1024, 1440]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 768 });
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await evaluate("document.querySelector('#categorias').scrollIntoView({block:'start',behavior:'instant'});");
        if (width < 768) await evaluate("document.querySelector('[data-open-filters]').click();");
        await fitViewport(width, `Categories ${theme} ${width}`);
        assert.ok(await evaluate("[...document.querySelectorAll('.filters [data-category]')].every(button=>button.checkVisibility() && button.getBoundingClientRect().height>=44 && button.querySelectorAll('svg').length===1)"));
        if ([390, 1440].includes(width)) await viewportShot(`catalog-categories-${theme}-${width}.png`);
        if (width < 768) await evaluate("document.querySelector('#filter-dialog [data-close-dialog]').click();");
        await evaluate('scrollTo({top:0,behavior:"instant"});new Promise(resolve=>setTimeout(resolve,100))');
        await fitViewport(width, `Home ${theme} ${width}`);
        assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), theme === 'light' ? 'rgb(248, 248, 244)' : 'rgb(15, 21, 18)');
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.card')).backgroundColor"), theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(23, 33, 27)');
        await waitFor(`document.querySelector('.hero-photo-${theme}').naturalWidth > 0`);
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.hero-photo-${theme}')).display`), 'block');
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.hero-photo-${theme === 'light' ? 'dark' : 'light'}')).display`), 'none');
        assert.ok(await evaluate("document.querySelector('.hero-actions a').getAttribute('href')==='#produtos' && document.querySelector('.hero-actions a:last-child').getAttribute('href')==='/ofertas'"));
        assert.ok(await evaluate("document.querySelector('#hero-title').getBoundingClientRect().right<=document.querySelector('.hero').getBoundingClientRect().right"), 'Hero title fits the banner');
        if (width >= 768) assert.ok(await evaluate("document.querySelector('.hero').getBoundingClientRect().height<=400"), 'Desktop banner stays at its original compact height');
        if ([390, 1440].includes(width)) await viewportShot(`redesign-home-${theme}-${width}.png`);
        await evaluate("document.querySelector('#cartBtn').click();");
        await waitFor("document.querySelector('#drawer').getBoundingClientRect().left>=0 && document.querySelector('#drawer').getBoundingClientRect().right<=innerWidth+1");
        assert.equal(await evaluate("document.querySelector('#co').hidden"), true);
        await evaluate("document.querySelector('#closeCart').click();");
      }
    }
    await evaluate("document.querySelector('[data-focus-search]').click();");
    assert.equal(await evaluate('document.activeElement.id'), 'search');
    await evaluate(`(() => {const input=document.querySelector('[data-product="${unitId}"] [data-unit-quantity]');input.value='1';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-product="${unitId}"] [data-add]').click();})()`);
    assert.match(await evaluate("document.querySelector('#home-shipping-message').textContent"), /Faltam/);
    await evaluate("document.querySelector('#clearCart').click();");
    await evaluate(`(() => {const input=document.querySelector('[data-product="${unitId}"] [data-unit-quantity]');input.value='4';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-product="${unitId}"] [data-add]').click();document.querySelector('[data-product="1"] [data-add]').click();document.querySelector('#cartBtn').click();})()`);
    assert.match(await evaluate("document.querySelector('#total').textContent"), /56,00/);
    await evaluate("document.querySelector('#delivery-area').value='maracanau';document.querySelector('#delivery-area').dispatchEvent(new Event('change'));");
    assert.match(await evaluate("document.querySelector('#shipping-progress-message').textContent"), /grátis liberada/);
    const checkoutInventory = db.prepare('SELECT id,stock_grams,stock_units FROM products ORDER BY id').all();
    const checkoutMovements = db.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count;
    const checkoutCount = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
    // Lose the first response after the real commit, then recover with an automatically emptied cart.
    // Only the successful WhatsApp navigation is redirected back to this temporary test origin.
    await evaluate(`(() => {const original=window.fetch;window.__loseCheckoutResponse=true;window.fetch=async(...args)=>{const response=await original(...args);if(args[0]==='/api/orders'){const payload=await response.json();window.__checkoutResult=payload;if(window.__loseCheckoutResponse){window.__loseCheckoutResponse=false;throw new Error('Resposta perdida de teste');}return new Response(JSON.stringify({...payload,whatsapp_url:'${site}/?checkout-test='+payload.id}),{status:response.status,headers:{'Content-Type':'application/json'}});}return response;};document.querySelector('#co [name="customer"]').value='Cliente do redesign';document.querySelector('#co [name="phone"]').value='85999999999';document.querySelector('#co [name="address"]').value='Endereço do teste';document.querySelector('#co [name="notes"]').value='Banco temporário';document.querySelector('#co').requestSubmit();})()`);
    await waitFor("document.querySelector('#msg').textContent.includes('Resposta perdida') && !document.querySelector('#checkout-recovery').hidden");
    const originalCheckoutId = await evaluate('window.__checkoutResult.id');
    const emptyRecoveryCatalog = await (await fetch(site + '/api/products')).json();
    emptyRecoveryCatalog.products = emptyRecoveryCatalog.products.map(product => ({...product,stock_grams:0,stock_units:0}));
    await evaluate(`loadCatalog(${JSON.stringify(emptyRecoveryCatalog)})`);
    assert.equal(await evaluate("document.querySelector('#co').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#checkout-recovery').hidden"), false);
    assert.deepEqual(await evaluate("JSON.parse(localStorage.getItem('puro-cart-weight-v1'))"), {});
    await evaluate("document.querySelector('#recover-checkout').click()");
    await waitFor("location.search.includes('checkout-test=') && document.querySelectorAll('.card').length===12");
    const checkoutId = await evaluate("Number(new URLSearchParams(location.search).get('checkout-test'))");
    assert.equal(checkoutId, originalCheckoutId, 'Recovery must reuse the order even after stock refresh removes every cart item');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM orders').get().count, checkoutCount + 1);
    assert.equal(await evaluate("sessionStorage.getItem('puro-checkout-request-v1')"), null);
    const checkout = db.prepare('SELECT * FROM orders WHERE id=?').get(checkoutId);
    assert.equal(checkout.total_cents, 5600);
    assert.equal(checkout.free_shipping, 1);
    assert.equal(checkout.delivery_city, 'Maracanaú');
    assert.equal(checkout.status, 'novo');
    assert.equal(checkout.stock_deducted, 0);
    assert.deepEqual(db.prepare('SELECT id,stock_grams,stock_units FROM products ORDER BY id').all(), checkoutInventory, 'Public checkout awaits admin confirmation before consuming stock');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM stock_movements').get().count, checkoutMovements);
    assert.equal(db.prepare('SELECT qty FROM order_items WHERE order_id=? AND sale_unit=\'unit\'').get(checkoutId).qty, 4);
    assert.deepEqual(await evaluate("JSON.parse(localStorage.getItem('puro-cart-weight-v1'))"), {});

    // Use the real promotion helpers to preview Tuesday without changing the business implementation.
    const { promotionState, discountFor } = require('../src/promotions');
    const promotionalCatalog = await (await fetch(site + '/api/products')).json();
    promotionalCatalog.promotion = promotionState(new Date('2026-10-06T15:00:00Z'));
    promotionalCatalog.products = promotionalCatalog.products.map(product => ({ ...product, discount_percent: discountFor(product, promotionalCatalog.promotion) }));
    await evaluate(`(() => {const data=${JSON.stringify(promotionalCatalog)};const original=window.fetch;window.fetch=(...args)=>args[0]==='/api/products'?Promise.resolve(new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})):original(...args);return loadCatalog();})()`);
    assert.equal(await evaluate("document.querySelector('#ofertas').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#ofertas .promotion-intro')"), null);
    assert.equal(await evaluate("document.querySelector('[data-promo-countdown]').hidden"), true);
    assert.ok(await evaluate("Boolean(document.querySelector('[data-product=\"1\"] .reference-price del'))"));
    const promoColor = await evaluate("getComputedStyle(document.querySelector('.offer-badge')).color");
    assert.equal(promoColor, 'rgb(227, 173, 87)');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await setTheme('light');
    await evaluate("document.querySelector('#produtos').scrollIntoView({block:'start',behavior:'instant'});");
    await viewportShot('redesign-promotion-light.png');
    await evaluate("document.querySelector('#kits-prontos').scrollIntoView({block:'start',behavior:'instant'});");
    await viewportShot('redesign-kits-light.png');
    await command('Page.navigate', { url: site + '/ofertas' });
    await waitFor("document.querySelectorAll('.card').length===12");
    assert.equal(await evaluate("document.querySelector('#grid').classList.contains('catalog-rows') || Boolean(document.querySelector('#grid .catalog-category-row'))"), false, 'The offers page preserves its existing flat grid');
    assert.match(await evaluate("document.querySelector('#catalog-status').textContent"), /Não há ofertas/);
    const offersDescriptionFixture = structuredClone(promotionalCatalog);
    const offersDescriptionProduct = offersDescriptionFixture.products[0];
    Object.assign(offersDescriptionProduct, { description: 'Ingredientes selecionados para a sua rotina.', tuesday_promo: 0, discount_percent: 20 });
    await evaluate(`loadCatalog(${JSON.stringify(offersDescriptionFixture)})`);
    await evaluate('clearTimeout(promotionTimer)');
    const offersDescriptionSelector = `#product-${offersDescriptionProduct.id} .product-description`;
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(offersDescriptionSelector)}).open`), false, 'The same native description starts closed on an offer card');
    await evaluate(`document.querySelector(${JSON.stringify(offersDescriptionSelector + ' summary')}).click();`);
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(offersDescriptionSelector)}).open && document.querySelector(${JSON.stringify(offersDescriptionSelector + ' .description')}).checkVisibility()`), 'An offer card reveals its description without leaving the page');
    assert.equal(await evaluate("document.querySelector('#grid').classList.contains('catalog-rows')"), false);
    await evaluate(`document.querySelector(${JSON.stringify(offersDescriptionSelector + ' summary')}).click();loadCatalog();`);
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.querySelector('[data-open-filters]').click();document.querySelector('.filters [data-category=\"Todos\"]').click();");
    await waitFor("!document.querySelector('#filter-dialog').open && !document.body.classList.contains('ui-dialog-open')");
    await waitFor("document.querySelector('#catalog-status').getBoundingClientRect().top>=document.querySelector('.store-header').getBoundingClientRect().bottom && document.querySelector('#catalog-status').getBoundingClientRect().top<180");
    assert.equal(await evaluate("document.querySelector('#filter-dialog .btn')"), null);
    await evaluate(`(() => {const data=${JSON.stringify(promotionalCatalog)};const original=window.fetch;window.fetch=(...args)=>args[0]==='/api/products'?Promise.resolve(new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})):original(...args);return loadCatalog();})()`);
    assert.equal(await evaluate("document.querySelector('#grid').classList.contains('catalog-rows') || Boolean(document.querySelector('#grid .catalog-category-row'))"), false, 'Refreshing offers must never create category carousels');
    assert.equal(await evaluate("document.querySelectorAll('.card:not([hidden])').length"), 0);
    assert.match(await evaluate("document.querySelector('#catalog-status').textContent"), /Não há ofertas/);
    for (const width of [360, 390, 430, 768, 1024, 1440]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
      for (const theme of ['light','dark']) { await setTheme(theme); await fitViewport(width, `Ofertas ${theme} ${width}`); }
    }
    await command('Page.navigate', { url: site });
    await waitFor("document.querySelectorAll('.card').length===12");
    // An editable banner must remain visible when every product shelf is empty.
    const bannerOnlyCatalog = await (await fetch(site + '/api/products')).json();
    bannerOnlyCatalog.products = bannerOnlyCatalog.products.map(product => ({...product, best_seller_rank: 0, is_new: 0, discount_percent: 0}));
    bannerOnlyCatalog.kits = [];
    await evaluate(`loadCatalog(${JSON.stringify(bannerOnlyCatalog)})`);
    assert.equal(await evaluate("document.querySelector('#home-highlights').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#home-banner').hidden"), false);
    assert.ok(await evaluate("['#best-sellers-section','#new-products-section','#ofertas','#kits-prontos'].every(id=>document.querySelector(id).hidden)"));
    bannerOnlyCatalog.banner.active = false;
    await evaluate(`loadCatalog(${JSON.stringify(bannerOnlyCatalog)})`);
    assert.equal(await evaluate("document.querySelector('#home-highlights').hidden"), true);
    await evaluate('loadCatalog()');
    // Check text contrast across the surfaces actually used by the design.
    const contrastChecks = await evaluate(`(() => {
      const luminance=color=>{const values=color.match(/[\\d.]+/g).slice(0,3).map(Number).map(value=>value/255).map(value=>value<=.04045?value/12.92:Math.pow((value+.055)/1.055,2.4));return values[0]*.2126+values[1]*.7152+values[2]*.0722;};
      const contrast=(foreground,background)=>{const a=luminance(foreground),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
      const probe=document.createElement('span');document.body.append(probe);const results=[];
      for(const theme of ['light','dark']){document.documentElement.dataset.theme=theme;for(const [text,surface] of [['text','background'],['text-secondary','surface'],['primary','primary-soft'],['on-primary','primary'],['offer-text','offer-soft'],['danger-text','danger-soft'],['text-on-tint','primary-soft'],['text-on-tint','surface-secondary'],['hero-title','hero-background'],['hero-text','hero-background'],['hero-action-text','hero-action'],['hero-muted','hero-background']]){probe.style.color='var(--'+text+')';probe.style.backgroundColor='var(--'+surface+')';const style=getComputedStyle(probe);results.push({theme,text,surface,ratio:contrast(style.color,style.backgroundColor)});}}probe.remove();return results;
    })()`);
    for (const check of contrastChecks) assert.ok(check.ratio >= 4.5, `Text contrast ${check.theme} ${check.text}/${check.surface}: ${check.ratio}`);
    await setTheme('dark');
    await command('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.card')).transitionDuration"), '0s');
    await command('Emulation.setEmulatedMedia', { features: [] });
    console.log('Redesign storefront passed: 360/390/430/768/1024/1440px, both themes, mobile menu, category dialog, keyboard, empty/full cart, actual checkout, Tuesday preview, offers and kits.');

    // A selling-method change removes the stale unit row and hides the outdated kit.
    db.prepare("UPDATE products SET sale_unit='weight',stock_grams=5000 WHERE id=?").run(unitId);
    await evaluate('checkPromotion()');
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('puro-cart-weight-v1'))['${unitId}:unit']`), undefined);
    assert.equal(await evaluate(`Boolean(document.querySelector('[data-add-kit="${mixedKitId}"]'))`), false);
    await command('Page.navigate', { url: site + '/admin' });
    await waitFor("typeof document.querySelector('#login')?.onsubmit === 'function'");
    await evaluate("document.querySelector('#pw').value='preview-only-password';document.querySelector('#login').requestSubmit();");
    await waitFor("document.querySelector('#dashboard-updated').textContent.includes('Atualizado')");
    // Inventory and costs use the isolated preview database, never the shop's data.
    await evaluate("document.querySelector('.tabs [data-t=\"pr\"]').click();");
    await waitFor("Boolean(document.querySelector('[data-e=\"1\"]'))");
    await evaluate("document.querySelector('[data-e=\"1\"]').click();document.querySelector('#pprice').value='49,00';document.querySelector('#pweight').value='1000';document.querySelector('#pcost').value='28,00';document.querySelector('#pcost').dispatchEvent(new Event('input'));");
    assert.match(await evaluate("document.querySelector('#product-profit-preview').textContent"), /42,86%/);
    assert.match(await evaluate("document.querySelector('#product-profit-preview').textContent"), /21,00/);
    await evaluate("document.querySelector('#pf').requestSubmit();");
    await waitFor("!document.querySelector('#psave').disabled && document.querySelector('#plist').textContent.includes('42,86%')");
    assert.equal(db.prepare('SELECT cost_cents FROM products WHERE id=1').get().cost_cents, 2800);
    const weightBalance = db.prepare('SELECT stock_grams FROM products WHERE id=1').get().stock_grams;
    await evaluate("document.querySelector('.tabs [data-t=\"st\"]').click();");
    await waitFor("document.querySelectorAll('#stock-history-rows tr').length>0");
    await evaluate("document.querySelector('#movement-product').value='1';document.querySelector('#movement-product').dispatchEvent(new Event('change'));document.querySelector('#movement-quantity').value='10000';document.querySelector('#movement-note').value='Compra para teste visual';document.querySelector('#stock-movement-form').requestSubmit();");
    await waitFor("!document.querySelector('#movement-submit').disabled && document.querySelector('#movement-feedback').textContent==='Movimentação registrada.'");
    assert.equal(db.prepare('SELECT stock_grams FROM products WHERE id=1').get().stock_grams, weightBalance + 10000);
    await evaluate("document.querySelector('#movement-reason').value='manual_adjustment';document.querySelector('#movement-reason').dispatchEvent(new Event('input'));document.querySelector('#movement-direction').value='out';document.querySelector('#movement-quantity').value='1000';document.querySelector('#movement-note').value='Ajuste para teste visual';document.querySelector('#stock-movement-form').requestSubmit();");
    await waitFor("!document.querySelector('#movement-submit').disabled && document.querySelector('#movement-quantity').value===''");
    assert.equal(db.prepare('SELECT stock_grams FROM products WHERE id=1').get().stock_grams, weightBalance + 9000);
    assert.match(await evaluate("document.querySelector('#stock-history-rows').textContent"), /−1 kg/);
    await evaluate("document.querySelector('#movement-quantity').value='9999999';document.querySelector('#movement-note').value='Saída inválida de teste';document.querySelector('#stock-movement-form').requestSubmit();");
    await waitFor("document.querySelector('#movement-feedback').classList.contains('err') && !document.querySelector('#movement-submit').disabled");
    assert.equal(db.prepare('SELECT stock_grams FROM products WHERE id=1').get().stock_grams, weightBalance + 9000);
    await evaluate("document.querySelector('#stock-history-product').value='1';document.querySelector('#stock-history-reason').value='purchase';document.querySelector('#stock-history-reason').dispatchEvent(new Event('change'));");
    await waitFor("document.querySelectorAll('#stock-history-rows tr').length===1");
    assert.match(await evaluate("document.querySelector('#stock-history-rows').textContent"), /\+10 kg/);
    const costOrder = await (await fetch(site + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer: 'Pedido com custo de teste', items: [{ id: 1, weight_grams: 250, qty: 1 }] }) })).json();
    assert.equal((await fetch(site + `/api/admin/orders/${costOrder.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-token': previewToken }, body: JSON.stringify({ status: 'pago' }) })).status, 200);
    await evaluate('loadProducts()');
    assert.equal(await evaluate("document.querySelector('#profit-month').textContent"), (costOrder.total_cents / 100 - 7).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
    await evaluate("document.querySelector('.tabs [data-t=\"or\"]').click();");
    await waitFor("document.querySelector('#olist').textContent.includes('Lucro bruto estimado:')");
    await evaluate("document.querySelector('#stock-history-product').value='';document.querySelector('#stock-history-reason').value='';document.querySelector('#movement-quantity').value='';document.querySelector('#movement-feedback').textContent='';");
    // Counter sales use only preview.db, sharing inventory with web orders.
    const counterUnit = await evaluate("api('/products','POST',{name:'Pote presencial',price:10,cost:4,sale_unit:'unit',stock_units:5,active:false})");
    const counterUnitId = counterUnit.id;
    const counterWeightBefore = db.prepare('SELECT stock_grams FROM products WHERE id=1').get().stock_grams;
    const counterOrdersBefore = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE sales_channel='in_person'").get().n;
    await evaluate("document.querySelector('.tabs [data-t=\"ps\"]').click()");
    await waitFor(`document.querySelector('#sales-product-select option[value="${counterUnitId}"]')`);
    // Real browser input exercises results, focus and selection without changing fixtures.
    const counterKey = async (key, code, virtualKey, extra = {}) => {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, ...extra });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers: extra.modifiers || 0 });
    };
    const typeCounterSearch = async text => {
      await evaluate("document.querySelector('#sales-search').focus()");
      await counterKey('a', 'KeyA', 65, { modifiers: 2 });
      await counterKey('Backspace', 'Backspace', 8);
      for (const character of text) {
        await command('Input.insertText', { text: character });
        assert.equal(await evaluate('document.activeElement.id'), 'sales-search', 'Typing must keep focus in the counter search field');
      }
      assert.equal(await evaluate("document.querySelector('#sales-search').value"), text);
    };
    const counterMatches = () => evaluate("[...document.querySelectorAll('#sales-search-matches [data-sales-product]')].map(button=>Number(button.dataset.salesProduct))");
    const clickCounterMatch = async id => {
      const point = await evaluate(`(() => {const button=document.querySelector('#sales-search-matches [data-sales-product="${id}"]');button.scrollIntoView({block:'center',behavior:'instant'});const box=button.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};})()`);
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await command('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await command('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    };
    await typeCounterSearch('acai po');
    assert.deepEqual(await counterMatches(), [7], 'Counter search ignores accents and matches separated words in the name');
    assert.equal(await evaluate("document.querySelector('#sales-search-results').hidden"), false);
    assert.match(await evaluate("document.querySelector('#sales-search-status').textContent"), /1 produto encontrado/);
    await typeCounterSearch('hibisco cha');
    assert.deepEqual(await counterMatches(), [8], 'Counter search accepts terms in a different order and skips intervening words');
    await evaluate("document.querySelector('#sales-category').value='Grãos';document.querySelector('#sales-category').dispatchEvent(new Event('change',{bubbles:true}))");
    assert.deepEqual(await counterMatches(), [], 'Search and category filters must apply together');
    assert.match(await evaluate("document.querySelector('#sales-search-status').textContent"), /Nenhum produto encontrado/);
    assert.equal(await evaluate("document.querySelector('#sales-add').disabled"), true);
    await evaluate("document.querySelector('#sales-category').value='Chás';document.querySelector('#sales-category').dispatchEvent(new Event('change',{bubbles:true}))");
    assert.deepEqual(await counterMatches(), [8]);
    await clickCounterMatch(8);
    assert.equal(await evaluate("document.querySelector('#sales-product-select').value"), '8');
    assert.equal(await evaluate('document.activeElement.id'), 'sales-weight', 'Selecting a weight result focuses its weight input');
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"), 0, 'Selecting a search result must not add it to the sale');
    await evaluate("document.querySelector('#sales-category').value='';document.querySelector('#sales-category').dispatchEvent(new Event('change',{bubbles:true}))");
    await typeCounterSearch('a');
    const keyboardMatches = await counterMatches();
    assert.ok(keyboardMatches.length >= 2, 'Keyboard navigation fixture needs multiple visible results');
    await counterKey('ArrowDown', 'ArrowDown', 40);
    assert.equal(await evaluate('Number(document.activeElement.dataset.salesProduct)'), keyboardMatches[0]);
    await counterKey('ArrowDown', 'ArrowDown', 40);
    assert.equal(await evaluate('Number(document.activeElement.dataset.salesProduct)'), keyboardMatches[1]);
    await counterKey('ArrowUp', 'ArrowUp', 38);
    assert.equal(await evaluate('Number(document.activeElement.dataset.salesProduct)'), keyboardMatches[0]);
    await counterKey('ArrowUp', 'ArrowUp', 38);
    assert.equal(await evaluate('document.activeElement.id'), 'sales-search', 'ArrowUp from the first result returns to the search');
    await counterKey('ArrowDown', 'ArrowDown', 40);
    await counterKey('Escape', 'Escape', 27);
    assert.equal(await evaluate('document.activeElement.id'), 'sales-search', 'Escape returns from results to the search');
    await typeCounterSearch('zzzzzzzz');
    assert.deepEqual(await counterMatches(), []);
    assert.match(await evaluate("document.querySelector('#sales-search-status').textContent"), /Nenhum produto encontrado/);
    assert.equal(await evaluate("document.querySelector('#sales-product-select').value"), '');
    await typeCounterSearch('');
    assert.equal(await evaluate("document.querySelector('#sales-search-results').hidden"), true, 'Clearing search removes the result list');
    assert.ok(await evaluate("document.querySelectorAll('#sales-product-select option').length>2"), 'Clearing search restores the catalogue selector');
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"), 0);
    await typeCounterSearch('po');
    assert.ok((await counterMatches()).includes(counterUnitId));
    for (const width of [390, 1440]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 768 });
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await evaluate("document.querySelector('#sales-products-heading').scrollIntoView({block:'start',behavior:'instant'})");
        await fitViewport(width, `Counter search ${theme} ${width}`);
        await viewportShot(`in-person-search-${theme}-${width}.png`);
      }
    }
    await typeCounterSearch('presencial pote');
    assert.deepEqual(await counterMatches(), [counterUnitId]);
    await counterKey('ArrowDown', 'ArrowDown', 40);
    await counterKey('Enter', 'Enter', 13, { text: '\r', unmodifiedText: '\r' });
    assert.equal(await evaluate("document.querySelector('#sales-product-select').value"), String(counterUnitId), 'Enter selects the focused result');
    assert.equal(await evaluate('document.activeElement.id'), 'sales-quantity', 'Selecting a unit result focuses its quantity input');
    assert.equal(await evaluate("document.querySelector('#sales-weight-label').hidden"), true);
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"), 0);
    assert.match(await evaluate("document.querySelector('#sales-product-detail').textContent"), /Oculto no catálogo online/);
    await evaluate("document.querySelector('#sales-quantity').value='2';document.querySelector('#sales-quantity').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#sales-add').click()");
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"), 1);
    await typeCounterSearch('artesanal granola');
    assert.deepEqual(await counterMatches(), [1]);
    await clickCounterMatch(1);
    assert.equal(await evaluate('document.activeElement.id'), 'sales-weight');
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"), 1, 'A second selection still needs the explicit add action');
    await evaluate("document.querySelector('#sales-weight').value='250';document.querySelector('#sales-weight').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#sales-add').click();document.querySelector('#sales-payment').value='pix';document.querySelector('#sales-payment').dispatchEvent(new Event('change',{bubbles:true}));");
    await typeCounterSearch('');
    assert.equal(await evaluate("document.querySelector('#sales-search-results').hidden"), true);
    console.log('Counter search passed: real typing and preserved focus, accent-insensitive unordered terms, category/empty/clear states, keyboard and mouse selection, weight/unit add actions and four themed screenshots.');
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"),2);
    assert.match(await evaluate("document.querySelector('#sales-total').textContent"),/32,25/);
    await evaluate("document.querySelector('.tabs [data-t=\"pr\"]').click();document.querySelector('.tabs [data-t=\"ps\"]').click();loadSales()");
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"),2,'Changing tabs preserves the sale draft');
    db.prepare('UPDATE products SET price_cents=1100 WHERE id=?').run(counterUnitId);
    await evaluate("document.querySelector('#sales-form').requestSubmit()");
    await waitFor("document.querySelector('#sales-feedback').classList.contains('is-error') && !document.querySelector('#sales-receipt-fields').disabled");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE sales_channel='in_person'").get().n,counterOrdersBefore,'Stale prices do not create a counter sale');
    assert.equal(db.prepare('SELECT stock_units FROM products WHERE id=?').get(counterUnitId).stock_units,5);
    assert.match(await evaluate("document.querySelector('#sales-total').textContent"),/34,25/);
    await evaluate("document.querySelector('#sales-form').requestSubmit();document.querySelector('#sales-form').requestSubmit()");
    await waitFor("document.querySelector('#sales-feedback').classList.contains('is-success') && !document.querySelector('#sales-receipt-fields').disabled");
    const counterSale = db.prepare("SELECT * FROM orders WHERE sales_channel='in_person' ORDER BY id DESC LIMIT 1").get();
    assert.equal(counterSale.status,'pago');
    assert.equal(counterSale.total_cents,3425);
    assert.equal(counterSale.payment_method,'pix');
    assert.equal(db.prepare('SELECT stock_grams FROM products WHERE id=1').get().stock_grams,counterWeightBefore-250);
    assert.equal(db.prepare('SELECT stock_units FROM products WHERE id=?').get(counterUnitId).stock_units,3);
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"),0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE sales_channel='in_person'").get().n,counterOrdersBefore+1,'Repeated submit creates one sale');
    await evaluate(`window.__counterConfirm=window.confirm;window.confirm=()=>true;document.querySelector('[data-cancel-sale="${counterSale.id}"]').click()`);
    await waitFor(`!document.querySelector('[data-cancel-sale="${counterSale.id}"]') && !document.querySelector('#sales-receipt-fields').disabled`);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(counterSale.id).status,'cancelado');
    assert.equal(db.prepare('SELECT stock_grams FROM products WHERE id=1').get().stock_grams,counterWeightBefore);
    assert.equal(db.prepare('SELECT stock_units FROM products WHERE id=?').get(counterUnitId).stock_units,5);
    await evaluate('window.confirm=window.__counterConfirm;delete window.__counterConfirm;');
    const addCounterUnit = async () => evaluate(`document.querySelector('#sales-product-select').value='${counterUnitId}';document.querySelector('#sales-product-select').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#sales-add').click();document.querySelector('#sales-payment').value='cartao';document.querySelector('#sales-payment').dispatchEvent(new Event('change',{bubbles:true}));`);
    await addCounterUnit();
    // The POST succeeds but its response is lost. Retry must confirm the same sale.
    await evaluate("window.__counterFetch=window.fetch;window.__counterLoseResponse=true;window.fetch=async(url,...args)=>{const response=await window.__counterFetch(url,...args);if(url==='/api/admin/sales'&&args[0]?.method==='POST'&&window.__counterLoseResponse){window.__counterLoseResponse=false;throw new TypeError('Resposta perdida no teste');}return response;};document.querySelector('#sales-form').requestSubmit()");
    await waitFor("!document.querySelector('#sales-retry').hidden");
    assert.equal(await evaluate("document.querySelector('#sales-receipt-fields').disabled"),true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE sales_channel='in_person'").get().n,counterOrdersBefore+2);
    assert.equal(db.prepare('SELECT stock_units FROM products WHERE id=?').get(counterUnitId).stock_units,4);
    const counterPendingId = await evaluate("JSON.parse(sessionStorage.getItem('puro-grao-admin-pending-sale')).payload.request_id");
    await command('Page.reload');
    await waitFor("document.querySelector('#app') && !document.querySelector('#app').hidden && document.querySelector('#dashboard-updated').textContent.includes('Atualizado')");
    await evaluate("document.querySelector('.tabs [data-t=\"ps\"]').click()");
    await waitFor("document.querySelector('#sales-retry') && !document.querySelector('#sales-retry').hidden");
    assert.equal(await evaluate("document.querySelector('#sales-receipt-fields').disabled"),true,'Reload preserves the uncertain sale');
    assert.equal(await evaluate("JSON.parse(sessionStorage.getItem('puro-grao-admin-pending-sale')).payload.request_id"),counterPendingId);
    await evaluate("document.querySelector('#sales-retry').click()");
    await waitFor("document.querySelector('#sales-retry').hidden && !document.querySelector('#sales-receipt-fields').disabled");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE sales_channel='in_person'").get().n,counterOrdersBefore+2);
    assert.equal(db.prepare('SELECT stock_units FROM products WHERE id=?').get(counterUnitId).stock_units,4);
    assert.equal(await evaluate("sessionStorage.getItem('puro-grao-admin-pending-sale')"),null,'Confirmed retry clears recovery data');
    await evaluate('window.__counterFetch=window.fetch;');
    await addCounterUnit();
    await evaluate("window.fetch=(url,...args)=>url==='/api/admin/sales'&&args[0]?.method==='GET'?Promise.reject(new TypeError('Falha no refresh do teste')):window.__counterFetch(url,...args);document.querySelector('#sales-form').requestSubmit()");
    await waitFor("document.querySelector('#sales-feedback').classList.contains('is-warning') && !document.querySelector('#sales-receipt-fields').disabled");
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"),0,'A confirmed sale stays cleared even when refresh fails');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE sales_channel='in_person'").get().n,counterOrdersBefore+3);
    assert.equal(db.prepare('SELECT stock_units FROM products WHERE id=?').get(counterUnitId).stock_units,3);
    await evaluate("window.fetch=window.__counterFetch;delete window.__counterFetch;document.querySelector('#sales-refresh').click()");
    await waitFor("document.querySelector('#sales-feedback').classList.contains('is-success') && !document.querySelector('#sales-refresh').disabled");
    await addCounterUnit();
    console.log('Counter sales passed: hidden products, mixed weights/units, draft persistence, stale total, double-submit, cancellation, lost-response retry and confirmed-sale refresh failure.');
    // Sales history fixtures belong only to preview.db and do not consume stock.
    const historySiteBefore = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE sales_channel='whatsapp'").get().n;
    const historyRevenueBefore = db.prepare("SELECT COALESCE(SUM(total_cents),0) AS n FROM orders WHERE sales_channel='whatsapp' AND status IN ('pago','entregue')").get().n;
    const historyInventoryBefore = db.prepare('SELECT id,stock_grams,stock_units FROM products ORDER BY id').all();
    const historyMovementCount = db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n;
    const historyFixtureIds = [];
    const historyInsert = db.prepare("INSERT INTO orders(customer,phone,notes,total_cents,status,created_at) VALUES(?,?,?,?,?,?)");
    const historyItem = db.prepare("INSERT INTO order_items(order_id,product_id,name,qty,price_cents,cost_cents,weight_grams,sale_unit) VALUES(?,1,?,1,1234,700,250,'weight')");
    for (let index=0;index<52;index++) {
      const id=Number(historyInsert.run('Histórico Júlia '+index,'85999999999','<img src=x onerror="window.__historyXss=true">',1234,['novo','confirmado','pago','entregue','cancelado'][index%5],new Date().toISOString()).lastInsertRowid);
      historyFixtureIds.push(id);
      historyItem.run(id,'Produto histórico por peso');
    }
    db.prepare('UPDATE orders SET total_cents=1434 WHERE id=?').run(historyFixtureIds[0]);
    db.prepare("INSERT INTO order_items(order_id,product_id,name,qty,price_cents,cost_cents,sale_unit,stock_units) VALUES(?,?,?,2,100,50,'unit',2)").run(historyFixtureIds[0],counterUnitId,'Produto histórico por unidade');
    const historyReady = () => waitFor("document.querySelector('#sales-history-refresh') && !document.querySelector('#sales-history-refresh').disabled && document.querySelector('#sales-history-records').getAttribute('aria-busy')==='false'");
    const historySearch = async value => {
      await evaluate(`document.querySelector('#sales-history-search').value=${JSON.stringify(value)};document.querySelector('#sales-history-search').dispatchEvent(new Event('input',{bubbles:true}));`);
      await historyReady();
    };
    await evaluate("document.querySelector('.tabs [data-t=\"sh\"]').click()");
    await historyReady();
    assert.equal(await evaluate("document.querySelector('#sales-history-channel').value"),'whatsapp');
    assert.equal(await evaluate("Number(document.querySelector('#sales-history-count').textContent)"),historySiteBefore+52);
    assert.equal(await evaluate("document.querySelectorAll('#sales-history-records .history-order').length"),25);
    const expectedHistoryRevenue=(historyRevenueBefore+20*1234)/100;
    assert.equal(await evaluate("document.querySelector('#sales-history-revenue').textContent"),expectedHistoryRevenue.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}));
    const historyFirstPage=await evaluate("[...document.querySelectorAll('[data-history-order]')].map(node=>node.dataset.historyOrder)");
    await evaluate("document.querySelector('#sales-history-next').click()");
    await historyReady();
    const historySecondPage=await evaluate("[...document.querySelectorAll('[data-history-order]')].map(node=>node.dataset.historyOrder)");
    assert.ok(historySecondPage.every(id=>!historyFirstPage.includes(id)));
    assert.equal(await evaluate("document.querySelector('#sales-history-revenue').textContent"),expectedHistoryRevenue.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}),'Revenue covers every filtered page');
    await evaluate("document.querySelector('#sales-history-search').focus();document.querySelector('#sales-history-search').value='';");
    await command('Input.insertText',{text:'julia'});
    await historyReady();
    assert.equal(await evaluate('document.activeElement.id'),'sales-history-search');
    assert.equal(await evaluate("document.querySelector('#sales-history-count').textContent"),'52');
    assert.match(await evaluate("document.querySelector('#sales-history-page').textContent"),/^1–25/);
    await evaluate("document.querySelector('.tabs [data-t=\"pr\"]').click();document.querySelector('.tabs [data-t=\"sh\"]').click()");
    await historyReady();
    assert.equal(await evaluate("document.querySelector('#sales-history-search').value"),'julia');
    await historySearch('#'+historyFixtureIds[0]);
    assert.equal(await evaluate("document.querySelectorAll('#sales-history-records .history-order').length"),1);
    await evaluate(`document.querySelector('[data-history-order="${historyFixtureIds[0]}"] summary').click()`);
    const historyDetails=await evaluate(`document.querySelector('[data-history-order="${historyFixtureIds[0]}"]').textContent`);
    assert.match(historyDetails,/250 g cada/);
    assert.match(historyDetails,/2 unidades/);
    assert.match(historyDetails,/12,34/);
    assert.match(historyDetails,/Custo registrado/);
    assert.equal(await evaluate("Boolean(document.querySelector('#sales-history-records img'))"),false,'History notes remain escaped text');
    assert.equal(await evaluate('Boolean(window.__historyXss)'),false);
    await evaluate("document.querySelector('#sales-history-clear').click();document.querySelector('#sales-history-channel').value='in_person';document.querySelector('#sales-history-channel').dispatchEvent(new Event('change',{bubbles:true}));");
    await historyReady();
    assert.equal(await evaluate("Number(document.querySelector('#sales-history-count').textContent)"),counterOrdersBefore+3);
    assert.ok(await evaluate("[...document.querySelectorAll('#sales-history-records .history-channel')].every(node=>node.textContent==='Presencial')"));
    await evaluate("document.querySelector('#sales-history-channel').value='all';document.querySelector('#sales-history-status').value='cancelado';document.querySelector('#sales-history-status').dispatchEvent(new Event('change',{bubbles:true}));");
    await historyReady();
    assert.ok(await evaluate("[...document.querySelectorAll('#sales-history-records .history-status')].every(node=>node.textContent==='Cancelado')"));
    assert.match(await evaluate("document.querySelector('#sales-history-revenue').textContent"),/0,00/);
    await evaluate("document.querySelector('#sales-history-clear').click()");
    await historyReady();
    const historyDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    await evaluate(`document.querySelector('#sales-history-from').value='${historyDay}';document.querySelector('#sales-history-to').value='${historyDay}';document.querySelector('#sales-history-to').dispatchEvent(new Event('change',{bubbles:true}));`);
    await historyReady();
    assert.ok(await evaluate("Number(document.querySelector('#sales-history-count').textContent)>=52"));
    await evaluate("document.querySelector('#sales-history-from').value='2030-01-02';document.querySelector('#sales-history-to').value='2030-01-01';document.querySelector('#sales-history-to').dispatchEvent(new Event('change',{bubbles:true}));");
    await historyReady();
    assert.match(await evaluate("document.querySelector('#sales-history-feedback').textContent"),/data inicial/);
    assert.equal(await evaluate("document.querySelector('#sales-history-count').textContent"),'—');
    await evaluate("document.querySelector('#sales-history-clear').click()");
    await historyReady();
    await historySearch('Cliente inexistente 987xyz');
    assert.equal(await evaluate("document.querySelector('#sales-history-empty').hidden"),false);
    assert.equal(await evaluate("document.querySelector('#sales-history-count').textContent"),'0');
    await historySearch('julia');
    await evaluate("document.querySelector('#sales-history-next').click()"); await historyReady();
    await evaluate("document.querySelector('#sales-history-next').click()"); await historyReady();
    for (const id of historyFixtureIds.slice(26)) {db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);db.prepare('DELETE FROM orders WHERE id=?').run(id);}
    await evaluate("document.querySelector('#sales-history-refresh').click()"); await historyReady();
    assert.match(await evaluate("document.querySelector('#sales-history-page').textContent"),/^26–26 de 26/,'Shrinking the last page returns to the new last page');
    await evaluate("window.__historyFetch=window.fetch;window.__historyDelay=true;window.fetch=(url,...args)=>url.startsWith('/api/admin/sales-history')&&window.__historyDelay?(window.__historyDelay=false,new Promise(resolve=>{window.__historyRelease=()=>resolve(new Response(JSON.stringify({error:'Sessao anterior'}),{status:401,headers:{'Content-Type':'application/json'}}));})):window.__historyFetch(url,...args);void loadSalesHistory();");
    await waitFor("typeof window.__historyRelease==='function'");
    await evaluate("document.querySelector('#out').click()");
    assert.equal(await evaluate("document.querySelectorAll('#sales-history-records .history-order').length"),0,'Logout removes private sales history');
    await evaluate("document.querySelector('#pw').value='preview-only-password';document.querySelector('#login').requestSubmit()");
    await waitFor("!document.querySelector('#app').hidden"); await historyReady();
    await evaluate("window.__historyRelease();new Promise(resolve=>setTimeout(resolve,100));");
    assert.equal(await evaluate("document.querySelector('#app').hidden"),false,'A stale 401 cannot end a newer login session');
    assert.equal(await evaluate("document.querySelector('#sales-history-channel').value"),'whatsapp');
    assert.ok(await evaluate("document.querySelectorAll('#sales-history-records .history-order').length>0"));
    await evaluate("window.fetch=window.__historyFetch;delete window.__historyFetch;delete window.__historyRelease;delete window.__historyDelay;");
    for (const id of historyFixtureIds) {db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);db.prepare('DELETE FROM orders WHERE id=?').run(id);}
    await evaluate('loadSalesHistory()');
    assert.deepEqual(db.prepare('SELECT id,stock_grams,stock_units FROM products ORDER BY id').all(),historyInventoryBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get().n,historyMovementCount);
    console.log('Sales history passed: live site records, all-page revenue, filters, snapshots, safe notes, pagination, shrinking pages, logout cleanup and stale-session protection.');
    for (const width of [360, 390, 430, 768, 1024, 1440]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
      for (const theme of ['light','dark']) {
        await setTheme(theme);
        for (const tab of ['db','pr','kt','or','bn','st','ps','sh']) {
          await evaluate(`document.querySelector('.tabs [data-t="${tab}"]').click();`);
          await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
          await fitViewport(width, `Admin ${tab} ${theme} ${width}`);
          assert.equal(await evaluate(`document.querySelector('#${tab}').hidden`), false);
          if (tab === 'st' && [390,1440].includes(width)) await viewportShot(`inventory-${theme}-${width}.png`);
          if (tab === 'pr' && [390,1440].includes(width)) {
            await evaluate("document.querySelector('.product-filters').scrollIntoView({block:'start',behavior:'instant'})");
            await viewportShot(`admin-product-filters-${theme}-${width}.png`);
          }
          if (tab === 'ps' && [390,1440].includes(width)) {
            await evaluate("document.querySelector('#ps').scrollIntoView({block:'start',behavior:'instant'})");
            await viewportShot(`in-person-sales-${theme}-${width}.png`);
          }
          if (tab === 'sh' && [390,1440].includes(width)) {
            await evaluate("document.querySelector('#sh').scrollIntoView({block:'start',behavior:'instant'})");
            await viewportShot(`sales-history-${theme}-${width}.png`);
          }
        }
        await evaluate("document.querySelector('.tabs [data-t=\"db\"]').click();scrollTo({top:0,behavior:'instant'});");
        if ([390,1440].includes(width)) await viewportShot(`redesign-admin-${theme}-${width}.png`);
      }
    }
    assert.equal(await evaluate("document.querySelector('#aerr').textContent.trim()"), '');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#aerr')).display"), 'none');
    console.log('Redesign admin passed: all eight sections at the six requested widths in light/dark, responsive table, forms, sales history, counter sales, banner preview and order status.');
    console.log('Inventory and costs passed: live margin preview, product cost saving, purchase, signed adjustment, negative-stock rejection, filters, order cost snapshots and gross-profit dashboard.');
    const deletionInventory = db.prepare('SELECT id, stock_grams, stock_units FROM products ORDER BY id').all();
    const deletionOrderCount = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
    await evaluate("document.querySelector('.tabs [data-t=\"or\"]').click();");
    await waitFor(`Boolean(document.querySelector('[data-order-delete="${checkoutId}"]'))`);
    await evaluate(`window.__deletionConfirm=window.confirm;window.confirm=()=>false;document.querySelector('[data-order-delete="${checkoutId}"] svg').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
    assert.ok(db.prepare('SELECT 1 FROM orders WHERE id=?').get(checkoutId), 'Declining confirmation must preserve the order');
    await evaluate(`window.confirm=()=>true;window.__deletionFetch=window.fetch;window.fetch=(url,...args)=>url==='/api/admin/orders/${checkoutId}'&&args[0]?.method==='DELETE'?Promise.resolve(new Response(JSON.stringify({error:'Falha simulada na exclusão'}),{status:503,headers:{'Content-Type':'application/json'}})):window.__deletionFetch(url,...args);document.querySelector('[data-order-delete="${checkoutId}"]').click();`);
    await waitFor("document.querySelector('#aerr').textContent.includes('Falha simulada')");
    assert.ok(db.prepare('SELECT 1 FROM orders WHERE id=?').get(checkoutId), 'Failed deletion must preserve the order');
    assert.equal(await evaluate(`document.querySelector('[data-order-delete="${checkoutId}"]').disabled`), false);
    assert.equal(await evaluate(`document.querySelector('[data-s="${checkoutId}"]').disabled`), false);
    await evaluate(`window.fetch=window.__deletionFetch;document.querySelector('[data-order-delete="${checkoutId}"] svg').dispatchEvent(new MouseEvent('click',{bubbles:true}));`);
    await waitFor(`!document.querySelector('[data-order-delete="${checkoutId}"]') && Number(document.querySelector('#orders-month').textContent)===${deletionOrderCount - 1}`);
    assert.equal(db.prepare('SELECT 1 FROM orders WHERE id=?').get(checkoutId), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE order_id=?').get(checkoutId).count, 0);
    assert.deepEqual(db.prepare('SELECT id, stock_grams, stock_units FROM products ORDER BY id').all(), deletionInventory);
    assert.equal(await evaluate("document.querySelector('#aerr').textContent"), '');
    await evaluate('window.confirm=window.__deletionConfirm;delete window.__deletionConfirm;delete window.__deletionFetch;');
    console.log('Order deletion passed: declined confirmation, recoverable error, icon click, updated list/dashboard and unchanged inventory.');
    console.log('Selling methods passed: unit product form, unit quantities, mixed carts/kits, stock limits, sharing and desktop/mobile layouts.');

    const previousToken = await evaluate('token');
    await evaluate("window.__privacyFetch=window.fetch;window.__privacyDelay=true;window.fetch=async(url,...args)=>{if(url==='/api/admin/orders'&&window.__privacyDelay){window.__privacyDelay=false;const response=await window.__privacyFetch(url,...args);const data=await response.json();return new Promise(resolve=>{window.__privacyRelease=()=>resolve(new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}}));});}return window.__privacyFetch(url,...args);};window.__privacyPending=loadOrders().catch(error=>error.code);document.querySelector('#pname').value='Rascunho privado';document.querySelector('#movement-note').value='Nota privada';");
    await waitFor("typeof window.__privacyRelease==='function'");
    await evaluate("document.querySelector('#out').click();");
    await waitFor("document.querySelector('#app').hidden && !document.querySelector('#login').hidden");
    assert.equal(await evaluate("document.querySelectorAll('[data-sales-line]').length"),0,'Logout clears the counter sale draft');
    assert.equal(await evaluate("document.querySelectorAll('#plist [data-e]').length"), 0);
    assert.equal(await evaluate("document.querySelector('#olist').innerHTML"), '');
    assert.equal(await evaluate("document.querySelector('#pname').value + document.querySelector('#movement-note').value"), '');
    assert.equal(await evaluate("sessionStorage.getItem('t')"), null);
    assert.equal(await evaluate("window.__privacyRelease();window.__privacyPending"), 'ADMIN_SESSION_STALE');
    assert.equal(await evaluate("document.querySelector('#olist').innerHTML"), '', 'A delayed successful response cannot restore customer data after logout');
    assert.equal(await evaluate("document.querySelector('#app').hidden"), true);
    await evaluate("window.fetch=window.__privacyFetch;delete window.__privacyFetch;delete window.__privacyRelease;delete window.__privacyPending;");
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch(site + '/api/admin/dashboard', { headers: { 'x-token': previousToken } });
      if (response.status === 401) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await fetch(site + '/api/admin/dashboard', { headers: { 'x-token': previousToken } })).status, 401);
    assert.deepEqual(cspViolations, [], 'CSP must preserve the existing storefront and admin flows');
    await evaluate("const injected=document.createElement('script');injected.textContent='window.__inlineScriptExecuted=true';document.body.append(injected);new Promise(resolve=>setTimeout(resolve,100));");
    assert.equal(await evaluate('Boolean(window.__inlineScriptExecuted)'), false, 'CSP blocks injected inline scripts');
    assert.ok(cspViolations.some(item => item.directive === 'script-src-elem' && item.blocked === 'inline'));
    console.log('Security browser checks passed: CSP-compatible flows, blocked inline scripts, pending checkout, private DOM cleanup, stale success/401 and revoked tokens.');
    if (process.argv.includes('--live')) {
      // Inspect the user's running storefront without writing to its database.
      await command('Page.navigate', { url: 'http://localhost:3000/#produtos' });
      await waitFor("Boolean(document.querySelector('#grid .product-photo'))");
      await evaluate("document.querySelector('#grid .product-photo').scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});");
      await waitFor("document.querySelector('#grid .product-photo')?.naturalWidth > 0");
      const ids = await evaluate("[...document.querySelectorAll('.has-photo')].map(frame=>frame.closest('[data-product]').dataset.product)");
      for (const id of ids) await assertPhotoFrame(`[data-product="${id}"] .product-photo`);
      await evaluate("document.querySelector('.has-photo').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>setTimeout(resolve,150));");
      const liveDesktop = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(artifacts, 'store-photo-fixed-desktop.png'), Buffer.from(liveDesktop.data, 'base64'));
      await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      for (const id of ids) await assertPhotoFrame(`[data-product="${id}"] .product-photo`);
      await evaluate("document.querySelector('.has-photo').scrollIntoView({block:'center',behavior:'instant'});new Promise(resolve=>setTimeout(resolve,150));");
      const liveMobile = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(artifacts, 'store-photo-fixed-mobile.png'), Buffer.from(liveMobile.data, 'base64'));
      console.log('Live storefront photo frames passed on desktop and mobile (read-only).');
    }
    assert.deepEqual(runtimeErrors, []);
    console.log('Browser checks passed: desktop, 390/320px mobile, light/dark, cart and focus, search, sharing, admin, dashboard, banner, kits, photos, live stock refresh and blocked session storage.');
    console.log('Screenshots saved in artifacts/.');
  } finally {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 99999, method: 'Browser.close' }));
    await Promise.race([browserClosed, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (browser.exitCode === null) browser.kill();
    socket?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    mock.timers.reset();
    // Both paths are created under the OS temporary directory by this script.
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
