export default [
  {
    name: 'first-run',
    viewport: 'portrait',
    selector: '#game',
    note: 'The first 30 seconds from a new player perspective',
    steps: [
      { wait: 900, shot: '01-menu', note: 'Title screen: is the game clear, are modes distinct, is the next action obvious' },
      { click: 'center', wait: 400, shot: '02-level-start', note: 'First level: readable field, visible lives and score' },
      { tick: 420, bot: 'normal', wait: 120, shot: '03-midgame', note: 'After 7 seconds: ball contrasts with the background and bricks remain distinct' },
      { tick: 900, bot: 'normal', wait: 120, shot: '04-later', note: 'Another 15 seconds: does particle clutter overwhelm the screen' },
      { expect: { fn: () => window.__FORGE__.state().score > 0, msg: 'score increases within 20 seconds of play' } },
      { expect: { fn: () => window.__FORGE__.state().bricks < window.totalBricksInLevel, msg: 'bricks are destroyed' } },
    ],
  },
  {
    name: 'powerups',
    viewport: 'portrait',
    selector: '#game',
    note: 'Power-up state: is the screen overloaded with indicators',
    steps: [
      { click: 'center', wait: 300 },
      { tick: 240, bot: 'normal' },
      {
        eval: () => {
          activatePowerUp(0); activatePowerUp(1); activatePowerUp(3);
          shieldActive = true; combo = 12; comboTimer = 180; spawnComboText(12);
          spawnPowerUpDrop(150, 300); spawnPowerUpDrop(300, 240);
        },
      },
      { tick: 30, wait: 150, shot: '01-powerups', note: 'Power-up icons, timers and combos: do they obscure the playfield' },
    ],
  },
  {
    name: 'game-over',
    viewport: 'portrait',
    selector: '#game',
    note: 'Game over is a major player exit point',
    steps: [
      { click: 'center', wait: 300 },
      { eval: () => { lives = 1; balls = []; } },
      { tick: 10, wait: 200, shot: '01-game-over', note: 'Is the outcome clear, and is restarting obvious' },
    ],
  },
  {
    name: 'phone',
    viewport: 'phone',
    selector: '#game',
    note: 'Phone: scale and legibility of small elements',
    steps: [
      { wait: 900, shot: '01-menu' },
      { click: 'center', wait: 300, tick: 300, bot: 'normal' },
      { wait: 120, shot: '02-play', note: 'Are the bricks and score too small at 390px' },
    ],
  },
];
