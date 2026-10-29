export default {
  name: 'Zombie Game (fixture)',
  root: '.',
  entry: 'index.html',
  viewport: 'desktop',
  renderer: '2d',
  // No adapter or scenarios: check that probe distinguishes a live rAF loop
  // from actual rendering.
  budgets: {
    frameMs: 16.7,
    errors: 0,
    bundleKb: 64,
    loadMs: 1500,
  },
};
