export default {
  name: 'Covered Button (fixture)',
  root: '.', entry: 'index.html', viewport: 'desktop', renderer: '2d',
  // Canvas-free interface: redraws only on input.
  renderMode: 'on-demand',
  scenarios: './forge/scenarios.mjs',
  hittable: {
    selectors: ['#go'],
    // Returning player: tutorial complete, button lies beneath the artwork.
    setup: [{ eval: 'window.__game.clickGo()' }],
  },
  budgets: { frameMs: 16.7, errors: 0, bundleKb: 64, loadMs: 1500 },
};
