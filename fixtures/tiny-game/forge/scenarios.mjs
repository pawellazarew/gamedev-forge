export default [
  {
    name: 'smoke',
    viewport: 'desktop',
    selector: '#game',
    note: 'Pipeline smoke run: initial screenshot and another after 10 seconds of play',
    steps: [
      { wait: 400, shot: '01-start', note: 'First frame: basket, score and lives' },
      { forge: ['start'], tick: 600, bot: 'veteran', wait: 100, shot: '02-play', note: '10 seconds of bot play' },
      { expect: { fn: () => window.__FORGE__.state().score > 0, msg: 'score increases' } },
      { expect: { fn: () => typeof window.__FORGE__.state().level === 'number', msg: 'state is readable' } },
    ],
  },
  {
    name: 'late-game',
    viewport: 'desktop',
    selector: '#game',
    note: 'Late stage: probe --scenario late-game measures this scene, not the initial screen',
    steps: [
      { forge: ['start'], tick: 1200, bot: 'veteran' },
    ],
  },
];
