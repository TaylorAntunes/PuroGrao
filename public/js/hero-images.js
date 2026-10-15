/* Only the decorative images rotate; the existing hero content stays fixed. */
(() => {
  const visual = document.querySelector('[data-hero-images]');
  if (!visual) return;
  const frames = [...visual.querySelectorAll('[data-hero-image]')];
  const promotion = visual.querySelector('[data-hero-promotion]');
  if (frames.length < 2 || !promotion) return;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0;
  let loaded = false;
  let inView = true;
  let timer;

  function show(next) {
    index = next;
    frames.forEach((frame, position) => {
      frame.dataset.active = String(position === index);
      frame.setAttribute('aria-hidden', String(position !== index));
    });
    visual.dataset.currentImage = String(index);
    visual.closest('.hero').dataset.currentImage = String(index);
  }
  function schedule() {
    clearTimeout(timer);
    if (!loaded || reducedMotion.matches || document.hidden || !inView) return;
    timer = setTimeout(() => {
      show((index + 1) % frames.length);
      schedule();
    }, 6000);
  }
  function ready() {
    if (!promotion.naturalWidth) return;
    loaded = true;
    schedule();
  }
  function failed() {
    loaded = false;
    clearTimeout(timer);
    show(0);
  }
  promotion.addEventListener('load', ready, { once: true });
  promotion.addEventListener('error', failed, { once: true });
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', schedule);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      inView = entries[0].isIntersecting;
      schedule();
    }).observe(visual.closest('.hero'));
  }
  if (promotion.complete) {
    if (promotion.naturalWidth) ready();
    else failed();
  }
})();
