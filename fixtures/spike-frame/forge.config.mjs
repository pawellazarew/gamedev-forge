export default {
  name: 'Spike Frame (fixture)',
  root: '.',
  entry: 'index.html',
  viewport: 'desktop',
  renderer: 'webgl',
  budgets: { frameMs: 16.7, errors: 0, bundleKb: 64, loadMs: 3000, drawCalls: 150 },
};
