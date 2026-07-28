export default {
  name: 'Zombie Game (фикстура)',
  root: '.',
  entry: 'index.html',
  viewport: 'desktop',
  renderer: '2d',
  // Ни адаптера, ни сценариев: проверяем, что probe отличает живой цикл rAF
  // от настоящей отрисовки.
  budgets: {
    frameMs: 16.7,
    errors: 0,
    bundleKb: 64,
    loadMs: 1500,
  },
};
