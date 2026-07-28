export default [
  {
    name: 'smoke',
    viewport: 'desktop',
    selector: '#game',
    note: 'Дымовой прогон конвейера: кадр стартового экрана и кадр через 10 секунд игры',
    steps: [
      { wait: 400, shot: '01-start', note: 'Первый кадр: корзина, счёт, жизни' },
      { forge: ['start'], tick: 600, bot: 'veteran', wait: 100, shot: '02-play', note: '10 секунд игры ботом' },
      { expect: { fn: () => window.__FORGE__.state().score > 0, msg: 'счёт растёт' } },
      { expect: { fn: () => typeof window.__FORGE__.state().level === 'number', msg: 'состояние читается' } },
    ],
  },
];
