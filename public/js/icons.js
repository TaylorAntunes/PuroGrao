// Small local SVG set; no dependency or remote script is needed.
(function (root) {
  const shapes = {
    leaf: '<path d="M20 4c0 9-4 15-10 15a6 6 0 0 1-6-6C4 7 11 4 20 4Z"/><path d="M4 21 16 9"/>',
    sprout: '<path d="M12 21v-9M12 15C5 15 3 10 3 6c6 0 9 3 9 9ZM12 12c0-6 4-9 9-9 0 6-3 9-9 9Z"/>',
    cup: '<path d="M4 9h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5ZM17 10h2a3 3 0 0 1 0 6h-2M7 3v3m5-3v3M2 22h19"/>',
    wheat: '<path d="m4 20 16-16M8 16c-4 0-5-3-4-6 3 0 5 2 4 6Zm4-4c-4 0-5-3-4-6 3 0 5 2 4 6Zm4-4c-3 0-4-2-3-5 3 0 4 2 3 5Zm-8 8c0 4 3 5 6 4 0-3-2-5-6-4Zm4-4c0 4 3 5 6 4 0-3-2-5-6-4Z"/>',
    nut: '<path d="M5 10c0-4 3-7 7-7s7 3 7 7M4 10h16l-1 5a7 7 0 0 1-14 0ZM9 10V6m6 4V6"/>',
    package: '<path d="m12 3 9 5v9l-9 5-9-5V8Zm0 9 9-4M12 12 3 8m9 4v10M7 5.8l9 5"/>',
    tag: '<path d="M20 13 11 22 2 13V3h10l8 8a2 2 0 0 1 0 2Z"/><circle cx="7" cy="8" r="1"/>',
    sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4"/>',
    trending: '<path d="m3 17 6-6 4 4 8-10M15 5h6v6"/>',
    truck: '<path d="M2 4h12v13H2ZM14 9h4l4 4v4h-8"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/>',
    bag: '<path d="M5 7h14l2 14H3ZM9 8V5a3 3 0 0 1 6 0v3"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    home: '<path d="m3 10 9-8 9 8v11H3ZM9 21v-8h6v8"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    filter: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
    edit: '<path d="m15 4 5 5M4 20l1-6L16 3a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L10 19ZM13 21h8"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
    chart: '<path d="M4 3v18h17M8 16v-5m5 5V7m5 9V4"/>',
    banner: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6M7 16h4"/>',
    shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
    whatsapp: '<path d="M21 11.5a9 9 0 0 1-13.2 8L3 21l1.5-4.8A9 9 0 1 1 21 11.5Z"/><path d="M8 7c-.5 4 2 7 6.5 7.5l1-2-2-1-1 1c-1-.5-2-1.5-2.5-2.5l1-1-1-2Z"/>',
  };
  const svg = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name] || shapes.leaf}</svg>`;
  function hydrate(parent = document) {
    parent.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = svg(element.dataset.icon); });
  }
  root.PuroIcons = { svg, hydrate };
  document.addEventListener('DOMContentLoaded', () => hydrate(), { once: true });
})(globalThis);
