export default {
  name: 'Моя игра',

  // что раздавать статикой и какой файл открывать
  root: '.',
  entry: 'index.html',

  // desktop | wide | portrait | phone | phoneLandscape | tablet
  viewport: 'desktop',

  // необязательны: без них работают probe и shots, но не sim
  adapter: './forge/adapter.mjs',
  scenarios: './forge/scenarios.mjs',

  // эталонные кадры для арт-критика (скриншоты игр, на которые целимся)
  references: 'forge/references',

  // пороги, ниже которых прогон считается провалившимся
  budgets: {
    frameMs: 16.7,   // бюджет одного кадра при 60 fps
    errors: 0,
    bundleKb: 8000,
    loadMs: 3000,
  },
};
