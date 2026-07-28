export default {
  name: 'REBOOT: Last Engineer',

  // гоняем собранный билд: он ближе к тому, что увидит игрок, чем dev-сервер
  root: 'dist',
  entry: 'index.html',

  viewport: 'wide',    // игра 960×540, Scale.FIT
  renderer: 'webgl',   // Phaser AUTO выбирает WebGL — иначе кадр будет чёрным

  adapter: './forge/adapter.mjs',
  scenarios: './forge/scenarios.mjs',
  references: 'forge/references',

  budgets: {
    frameMs: 16.7,
    errors: 0,
    bundleKb: 2500,   // Phaser сам весит ~1.6 МБ; следим, чтобы не разрасталось
    loadMs: 3000,
  },
};
