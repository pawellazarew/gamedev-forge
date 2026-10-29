export default {
  name: 'REBOOT: Last Engineer',

  // Test the built game: closer to the player experience than a dev server.
  root: 'dist',
  entry: 'index.html',

  viewport: 'wide',    // 960×540 game, Scale.FIT
  renderer: 'webgl',   // Phaser AUTO selects WebGL; otherwise screenshots are black

  adapter: './forge/adapter.mjs',
  scenarios: './forge/scenarios.mjs',
  references: 'forge/references',

  budgets: {
    frameMs: 16.7,
    errors: 0,
    bundleKb: 2500,   // Phaser itself is ~1.6 MB; keep bundle growth in check
    loadMs: 3000,
  },
};
