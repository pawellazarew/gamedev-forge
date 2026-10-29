export default {
  name: 'Brick Breaker',
  root: 'dist',
  entry: 'index.html',
  viewport: 'portrait',
  adapter: './forge/adapter.mjs',
  scenarios: './forge/scenarios.mjs',
  references: 'forge/references',
  budgets: {
    frameMs: 16.7,   // one-frame budget at 60 fps
    errors: 0,
    bundleKb: 1200,   // single-file game with little reason to grow
    loadMs: 1500,
  },
};
