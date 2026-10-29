export default {
  name: 'Dirty Render (fixture)',
  root: '.', entry: 'index.html', viewport: 'desktop', renderer: '2d',
  // Event-driven rendering: drawing nothing for 3 seconds is normal here.
  renderMode: 'on-demand',
  budgets: { frameMs: 16.7, errors: 0, bundleKb: 64, loadMs: 1500 },
};
