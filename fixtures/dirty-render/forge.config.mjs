export default {
  name: 'Dirty Render (фикстура)',
  root: '.', entry: 'index.html', viewport: 'desktop', renderer: '2d',
  // Игра рисует по событию — «за 3 секунды ничего не нарисовано» тут норма.
  renderMode: 'on-demand',
  budgets: { frameMs: 16.7, errors: 0, bundleKb: 64, loadMs: 1500 },
};
