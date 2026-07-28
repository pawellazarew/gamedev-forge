export default {
  name: 'Dead Game (фикстура)',
  root: '.',
  entry: 'index.html',
  viewport: 'desktop',
  renderer: '2d',
  // Ни адаптера, ни сценариев: проверяем универсальный слой probe на игре,
  // которая выглядит живой, но ничего не перерисовывает.
  budgets: {
    frameMs: 16.7,
    errors: 0,
    bundleKb: 64,
    loadMs: 1500,
  },
};
