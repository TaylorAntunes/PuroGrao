/* Only visual status feedback; order transitions remain in admin.js. */
(function () {
  const orders = document.querySelector('#olist');
  function updateStatuses() {
    orders?.querySelectorAll('select[data-s]').forEach(select => { select.dataset.status = select.value; });
  }
  if (orders) {
    new MutationObserver(updateStatuses).observe(orders, { childList: true });
    orders.addEventListener('change', updateStatuses);
    updateStatuses();
  }
})();
