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
  let scheduled = false;
  function updateCatalogPresentation() {
    scheduled = false;
    const loading = /preparando|carregando/i.test(status?.textContent || '');
    if (status) status.dataset.state = loading ? 'loading' : /não foi possível|erro/i.test(status.textContent) ? 'error' : 'empty';
    grid?.setAttribute('aria-busy', String(Boolean(loading)));
    const count = [...(grid?.querySelectorAll('.card') || [])].filter(card => !card.hidden).length;
    const result = query('#catalog-result-count');
    if (result && !loading) result.textContent = `${count} ${count === 1 ? 'produto encontrado' : 'produtos encontrados'}`;
  }
  function schedulePresentation() { if (!scheduled) { scheduled = true; requestAnimationFrame(updateCatalogPresentation); } }
  if (grid) new MutationObserver(schedulePresentation).observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  if (status) new MutationObserver(schedulePresentation).observe(status, { childList: true, attributes: true, attributeFilter: ['hidden'] });
  updateCatalogPresentation();
  const whatsapp = query('#wa');
  if (whatsapp) {
    const syncWhatsApp = () => document.querySelectorAll('[data-whatsapp-link]').forEach(link => { link.href = whatsapp.href; });
    new MutationObserver(syncWhatsApp).observe(whatsapp, { attributes: true, attributeFilter: ['href'] });
    syncWhatsApp();
  }
})();
