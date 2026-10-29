export default {
  name: 'Dead Game (fixture)',
  root: '.',
  entry: 'index.html',
  viewport: 'desktop',
  renderer: '2d',
  // No adapter or scenarios: exercise generic probe checks on a game that
  // looks alive but never redraws.
  budgets: {
    frameMs: 16.7,
    errors: 0,
    bundleKb: 64,
    loadMs: 1500,
  },
};
