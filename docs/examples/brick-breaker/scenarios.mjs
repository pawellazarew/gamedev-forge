export default [
  {
    name: 'first-run',
    viewport: 'portrait',
    selector: '#game',
    note: 'Первые 30 секунд глазами нового игрока',
    steps: [
      { wait: 900, shot: '01-menu', note: 'Титульный экран: ясно ли, что за игра, чем режимы отличаются, куда жать' },
      { click: 'center', wait: 400, shot: '02-level-start', note: 'Старт первого уровня: читается ли поле, видно ли жизни и счёт' },
      { tick: 420, bot: 'normal', wait: 120, shot: '03-midgame', note: '7 секунд игры: видно ли мяч на фоне, не сливаются ли кирпичи' },
      { tick: 900, bot: 'normal', wait: 120, shot: '04-later', note: 'Ещё 15 секунд: не превратился ли экран в кашу из частиц' },
      { expect: { fn: () => window.__FORGE__.state().score > 0, msg: 'счёт растёт за 20 секунд игры' } },
      { expect: { fn: () => window.__FORGE__.state().bricks < window.totalBricksInLevel, msg: 'кирпичи разбиваются' } },
    ],
  },
  {
    name: 'powerups',
    viewport: 'portrait',
    selector: '#game',
    note: 'Состояние с бонусами: перегружен ли экран индикаторами',
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
      { tick: 30, wait: 150, shot: '01-powerups', note: 'Иконки бонусов, таймеры, комбо — не перекрывают ли игровое поле' },
    ],
  },
  {
    name: 'game-over',
    viewport: 'portrait',
    selector: '#game',
    note: 'Экран проигрыша — главная точка выхода игрока',
    steps: [
      { click: 'center', wait: 300 },
      { eval: () => { lives = 1; balls = []; } },
      { tick: 10, wait: 200, shot: '01-game-over', note: 'Понятно ли, что произошло и как начать заново' },
    ],
  },
  {
    name: 'phone',
    viewport: 'phone',
    selector: '#game',
    note: 'Телефон: масштаб, читаемость мелких элементов',
    steps: [
      { wait: 900, shot: '01-menu' },
      { click: 'center', wait: 300, tick: 300, bot: 'normal' },
      { wait: 120, shot: '02-play', note: 'Не мелкие ли кирпичи и счёт на 390px' },
    ],
  },
];
