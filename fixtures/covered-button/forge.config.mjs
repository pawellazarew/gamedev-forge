export default {
  name: 'Covered Button (фикстура)',
  root: '.', entry: 'index.html', viewport: 'desktop', renderer: '2d',
  // Интерфейс без канваса: перерисовывается только по вводу.
  renderMode: 'on-demand',
  scenarios: './forge/scenarios.mjs',
  hittable: {
    selectors: ['#go'],
    // Вернувшийся игрок: урок уже пройден, кнопка лежит под артом
    setup: [{ eval: 'window.__game.clickGo()' }],
  },
  budgets: { frameMs: 16.7, errors: 0, bundleKb: 64, loadMs: 1500 },
};
