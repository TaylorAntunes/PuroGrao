(() => {
  const key = 'puro-theme';
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;

  function readPreference() {
    try {
      const saved = localStorage.getItem(key);
      return saved === 'dark' || saved === 'light' ? saved : null;
    } catch (_) {
      return null;
    }
  }

  function applyTheme() {
    const dark = (preference || (systemTheme.matches ? 'dark' : 'light')) === 'dark';
    root.dataset.theme = dark ? 'dark' : 'light';
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const label = dark ? 'Ativar modo claro' : 'Ativar modo escuro';
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', 'Modo escuro');
      button.title = label;
      button.querySelector('[data-theme-label]').textContent = dark ? 'Modo claro' : 'Modo escuro';
    });
  }

  preference = readPreference();
  applyTheme();

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.addEventListener('click', () => {
        preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(key, preference); } catch (_) {}
        applyTheme();
      });
    });
  });

  systemTheme.addEventListener('change', () => {
    if (!preference) applyTheme();
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      preference = readPreference();
      applyTheme();
    }
  });
})();
