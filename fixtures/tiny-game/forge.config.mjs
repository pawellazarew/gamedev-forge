export default {
  name: 'Tiny Game (фикстура)',
  root: '.',
  entry: 'index.html',
  viewport: 'desktop',
  renderer: '2d',
  adapter: './forge/adapter.mjs',
  scenarios: './forge/scenarios.mjs',
  budgets: {
    frameMs: 16.7,
    errors: 0,
    bundleKb: 64,
    loadMs: 1500,
  },
};
