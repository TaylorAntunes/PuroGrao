/* Presentation adapters. Product filtering, quantities, checkout and pricing stay in store.js. */
(function () {
  const query = selector => document.querySelector(selector);
  const filters = query('.filters');
  const mobile = matchMedia('(max-width:767px)');
  const filterDialog = query('#filter-dialog');
  let dialogTrigger;
  function openDialog(dialog, trigger) {
    if (!dialog || dialog.open) return;
    dialogTrigger = trigger;
    dialog.showModal();
    document.body.classList.add('ui-dialog-open');
    trigger?.setAttribute('aria-expanded', 'true');
  }
  function closeDialog(dialog) {
    if (dialog?.open) dialog.close();
  }
  document.querySelectorAll('.ui-dialog').forEach(dialog => {
    dialog.addEventListener('close', () => {
      document.body.classList.remove('ui-dialog-open');
      dialogTrigger?.setAttribute('aria-expanded', 'false');
      if (dialogTrigger?.getClientRects().length) dialogTrigger.focus();
    });
    dialog.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => closeDialog(dialog)));
    dialog.addEventListener('click', event => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) closeDialog(dialog); });
  });
  const imageDialog = query('#product-image-dialog');
  const enlargedImage = imageDialog?.querySelector('img');
  const imageStatus = query('#product-image-status');
  if (imageDialog && enlargedImage && imageStatus) {
    enlargedImage.addEventListener('load', () => {
      enlargedImage.hidden = false;
      imageStatus.hidden = true;
    });
    enlargedImage.addEventListener('error', () => {
      enlargedImage.hidden = true;
      imageStatus.textContent = 'Não foi possível carregar esta foto. Feche e tente novamente.';
      imageStatus.hidden = false;
    });
    document.addEventListener('click', event => {
      const trigger = event.target.closest('[data-open-product-image]');
      const photo = trigger?.querySelector('img');
      if (!photo || imageDialog.open) return;
      query('#product-image-title').textContent = photo.alt;
      imageStatus.textContent = 'Carregando imagem…';
      imageStatus.hidden = false;
      enlargedImage.hidden = true;
      enlargedImage.alt = photo.alt;
      enlargedImage.src = photo.currentSrc || photo.src;
      openDialog(imageDialog, trigger);
    });
    imageDialog.addEventListener('close', () => {
      enlargedImage.removeAttribute('src');
      enlargedImage.alt = '';
      enlargedImage.hidden = true;
    });
  }
  query('[data-open-menu]')?.addEventListener('click', event => openDialog(query('#mobile-menu'), event.currentTarget));
  query('#mobile-menu')?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => closeDialog(query('#mobile-menu'))));
  query('[data-open-filters]')?.addEventListener('click', event => openDialog(filterDialog, event.currentTarget));
  function placeFilters() {
    if (!filters) return;
    if (!mobile.matches) closeDialog(filterDialog);
    const slot = query(mobile.matches ? '.filter-dialog-slot' : '.filter-desktop-slot');
    if (slot && filters.parentElement !== slot) slot.append(filters);
  }
  mobile.addEventListener('change', placeFilters);
  placeFilters();
  filters?.addEventListener('click', event => {
    if (!mobile.matches || !filterDialog?.open || !event.target.closest('[data-category]')) return;
    filterDialog.addEventListener('close', () => {
      const product = query('#grid .card:not([hidden])');
      product?.focus({ preventScroll: true });
      (product || query('#catalog-status'))?.scrollIntoView({ block: 'start' });
    }, { once: true });
    closeDialog(filterDialog);
  });
  function clearFilters() {
    [...(filters?.querySelectorAll('[data-category]') || [])].find(button => button.dataset.category === 'Todos')?.click();
    const search = query('#search');
    if (search) { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  query('[data-clear-filters]')?.addEventListener('click', clearFilters);
  query('[data-focus-search]')?.addEventListener('click', () => { query('#produtos')?.scrollIntoView({ block: 'start' }); query('#search')?.focus({ preventScroll: true }); });
  const categoryIcon = category => {
    const name = category.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return name === 'todos' ? 'grid' : name.includes('cha') ? 'cup' : name.includes('castanh') ? 'nut' : name.includes('gra') || name.includes('farinh') ? 'wheat' : name.includes('sement') ? 'sprout' : 'leaf';
  };
  function updateCategories() {
    if (!filters) return;
    const buttons = [...filters.querySelectorAll('[data-category]')];
    const active = buttons.find(button => button.getAttribute('aria-pressed') === 'true');
    const label = query('[data-filter-label]');
    if (label) label.textContent = active && active.dataset.category !== 'Todos' ? `Filtros · ${active.dataset.category}` : 'Filtros';
    buttons.forEach(button => {
      if (button.querySelector('.category-label')) return;
      const text = document.createElement('span');
      text.className = 'category-label';
      text.textContent = button.dataset.category;
      button.type = 'button';
      button.innerHTML = PuroIcons.svg(categoryIcon(button.dataset.category));
      button.append(text);
    });
  }
  if (filters) {
    new MutationObserver(updateCategories).observe(filters, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
    updateCategories();
  }
  const grid = query('#grid');
  const status = query('#catalog-status');
  const reducedMotion = matchMedia('(prefers-reduced-motion:reduce)');
  let catalogCards = [];
  let catalogCardSet = new Set();
  let categoryRows = [];
  let groupedCatalog = false;
  const carouselPositions = new Map();
  const carouselResize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => categoryRows.forEach(scheduleCarouselControls)) : null;
  function updateCarouselControls(row) {
    row.scheduled = false;
    if (!row.track.isConnected) return;
    const limit = row.track.scrollWidth - row.track.clientWidth;
    const overflowing = limit > 1;
    if (row.controls.hidden === overflowing) row.controls.hidden = !overflowing;
    row.previous.disabled = !overflowing || row.track.scrollLeft <= 1;
    row.next.disabled = !overflowing || row.track.scrollLeft >= limit - 1;
  }
  function scheduleCarouselControls(row) {
    if (row.scheduled) return;
    row.scheduled = true;
    requestAnimationFrame(() => updateCarouselControls(row));
  }
  function scrollCategory(row, direction) {
    row.track.scrollBy({ left: row.track.clientWidth * .9 * direction, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }
  function revealCarouselCard(card) {
    const track = card?.closest('.catalog-carousel-track');
    if (!track) return;
    const item = card.getBoundingClientRect();
    const frame = track.getBoundingClientRect();
    const offset = item.left < frame.left + 8 ? item.left - frame.left - 8 : item.right > frame.right - 8 ? item.right - frame.right + 8 : 0;
    if (offset) track.scrollBy({ left: offset, behavior: 'instant' });
  }
  function revealAfterNavigation(card) {
    requestAnimationFrame(() => {
      if (card?.isConnected && card.contains(document.activeElement)) revealCarouselCard(card);
    });
  }
  function createCategoryRow(category, cards, index) {
    const section = document.createElement('section');
    section.className = 'catalog-category-row';
    section.dataset.catalogCategory = category;
    const headingId = `catalog-category-title-${index}`;
    const trackId = `catalog-category-track-${index}`;
    section.setAttribute('aria-labelledby', headingId);
    const header = document.createElement('div');
    header.className = 'catalog-category-heading';
    const title = document.createElement('div');
    title.className = 'catalog-category-title';
    const heading = document.createElement('h3');
    heading.id = headingId;
    heading.innerHTML = PuroIcons.svg(categoryIcon(category));
    const name = document.createElement('span');
    name.textContent = category;
    heading.append(name);
    const count = document.createElement('span');
    count.className = 'catalog-category-count';
    count.textContent = `${cards.length} ${cards.length === 1 ? 'produto' : 'produtos'}`;
    title.append(heading, count);
    const controls = document.createElement('div');
    controls.className = 'catalog-carousel-controls';
    controls.hidden = true;
    const track = document.createElement('div');
    track.id = trackId;
    track.className = 'catalog-carousel-track';
    track.tabIndex = 0;
    track.setAttribute('role', 'group');
    track.setAttribute('aria-labelledby', headingId);
    track.setAttribute('aria-roledescription', 'carrossel');
    const row = { category, track, controls, scheduled: false };
    ['previous', 'next'].forEach(direction => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'icon-button';
      button.dataset.carouselDirection = direction;
      button.setAttribute('aria-label', `${direction === 'previous' ? 'Produtos anteriores' : 'Próximos produtos'} de ${category}`);
      button.setAttribute('aria-controls', trackId);
      button.innerHTML = PuroIcons.svg('arrow');
      button.addEventListener('click', () => scrollCategory(row, direction === 'previous' ? -1 : 1));
      row[direction] = button;
      controls.append(button);
    });
    track.addEventListener('scroll', () => {
      carouselPositions.set(category, track.scrollLeft);
      scheduleCarouselControls(row);
    }, { passive: true });
    track.addEventListener('keydown', event => {
      if (event.target !== track || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      scrollCategory(row, event.key === 'ArrowLeft' ? -1 : 1);
    });
    track.append(...cards);
    header.append(title, controls);
    section.append(header, track);
    row.section = section;
    return row;
  }
  function updateCatalogLayout() {
    if (!grid || document.body.dataset.page === 'offers') return;
    const cards = [...grid.querySelectorAll('.card')];
    const replaced = cards.length !== catalogCards.length || cards.some(card => !catalogCardSet.has(card));
    if (replaced) {
      catalogCards = cards;
      catalogCardSet = new Set(cards);
      carouselResize?.disconnect();
      categoryRows = [];
      groupedCatalog = false;
    }
    const all = filters?.querySelector('[data-category][aria-pressed="true"]')?.dataset.category === 'Todos';
    const grouped = all && !query('#search')?.value.trim() && cards.length > 0;
    if (grouped === groupedCatalog && !replaced) return;
    const focused = document.activeElement;
    const restoreFocus = grid.contains(focused);
    carouselResize?.disconnect();
    if (grouped) {
      const categories = new Map();
      catalogCards.forEach(card => {
        const category = card.querySelector('.product-category')?.textContent.trim() || 'Sem categoria';
        if (!categories.has(category)) categories.set(category, []);
        categories.get(category).push(card);
      });
      categoryRows = [...categories].sort(([a], [b]) => a.localeCompare(b, 'pt-BR')).map(([category, items], index) => createCategoryRow(category, items, index));
      grid.replaceChildren(...categoryRows.map(row => row.section));
      grid.classList.add('catalog-rows');
      categoryRows.forEach(row => {
        row.track.scrollLeft = carouselPositions.get(row.category) || 0;
        carouselResize?.observe(row.track);
        scheduleCarouselControls(row);
      });
    } else {
      categoryRows.forEach(row => carouselPositions.set(row.category, row.track.scrollLeft));
      grid.replaceChildren(...catalogCards);
      grid.classList.remove('catalog-rows');
      categoryRows = [];
    }
    groupedCatalog = grouped;
    if (restoreFocus && focused.isConnected && !focused.closest('[hidden]')) {
      focused.focus({ preventScroll: true });
      revealCarouselCard(focused.closest('.card'));
    }
  }
  filters?.addEventListener('click', event => { if (event.target.closest('[data-category]')) updateCatalogLayout(); });
  query('#search')?.addEventListener('input', updateCatalogLayout);
  query('#home-highlights')?.addEventListener('click', event => {
    updateCatalogLayout();
    const link = event.target.closest('[data-choose-product]');
    if (link && !event.target.closest('[data-open-product-image]')) revealAfterNavigation(query(`#product-${Number(link.dataset.chooseProduct)}`));
  });
  let pointerFocusing = false;
  const markPointerFocus = () => {
    pointerFocusing = true;
    setTimeout(() => { pointerFocusing = false; }, 0);
  };
  grid?.addEventListener('pointerdown', markPointerFocus, { passive: true });
  grid?.addEventListener('mousedown', markPointerFocus, { passive: true });
  grid?.addEventListener('focusin', event => {
    if (pointerFocusing) return;
    const card = event.target.closest('.card');
    revealCarouselCard(card);
    revealAfterNavigation(card);
  });
  window.addEventListener('hashchange', () => {
    const match = location.hash.match(/^#product-(\d+)$/);
    if (match) revealAfterNavigation(query(`#product-${Number(match[1])}`));
  });
  window.addEventListener('resize', () => categoryRows.forEach(scheduleCarouselControls));
  let scheduled = false;
  function updateCatalogPresentation() {
    scheduled = false;
    updateCatalogLayout();
    const loading = /preparando|carregando/i.test(status?.textContent || '');
    if (status) status.dataset.state = loading ? 'loading' : /não foi possível|erro/i.test(status.textContent) ? 'error' : 'empty';
    grid?.setAttribute('aria-busy', String(Boolean(loading)));
    const count = [...(grid?.querySelectorAll('.card') || [])].filter(card => !card.hidden).length;
    const result = query('#catalog-result-count');
    if (result && !loading) result.textContent = `${count} ${count === 1 ? 'produto encontrado' : 'produtos encontrados'}`;
  }
  function schedulePresentation() { if (!scheduled) { scheduled = true; requestAnimationFrame(updateCatalogPresentation); } }
  if (grid) new MutationObserver(records => {
    if (records.some(record => record.target === grid && record.type === 'childList')) updateCatalogLayout();
    schedulePresentation();
  }).observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  if (status) new MutationObserver(schedulePresentation).observe(status, { childList: true, attributes: true, attributeFilter: ['hidden'] });
  updateCatalogPresentation();
  const whatsapp = query('#wa');
  if (whatsapp) {
    const syncWhatsApp = () => document.querySelectorAll('[data-whatsapp-link]').forEach(link => { link.href = whatsapp.href; });
    new MutationObserver(syncWhatsApp).observe(whatsapp, { attributes: true, attributeFilter: ['href'] });
    syncWhatsApp();
  }
})();
