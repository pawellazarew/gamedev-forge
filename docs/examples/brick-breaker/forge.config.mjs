export default {
  name: 'Brick Breaker',
  root: 'dist',
  entry: 'index.html',
  viewport: 'portrait',
  adapter: './forge/adapter.mjs',
  scenarios: './forge/scenarios.mjs',
  references: 'forge/references',
  budgets: {
    frameMs: 16.7,   // бюджет одного кадра при 60 fps
    errors: 0,
    bundleKb: 1200,   // игра — один файл, раздуваться ей некуда
    loadMs: 1500,
  },
};
