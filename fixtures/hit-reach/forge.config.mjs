export default {
  name: 'Hit Reach (fixture)',
  root: '.', entry: 'index.html', viewport: 'desktop', renderer: '2d',
  renderMode: 'on-demand',
  scenarios: './forge/scenarios.mjs',
  budgets: { frameMs: 16.7, errors: 0, bundleKb: 64, loadMs: 1500 },
};
