/**
 * Сценарии: что forge проходит и в какие моменты снимает кадры.
 * Ключи шага применяются в порядке: goto → forge → eval → click → realClick →
 * move → key → type → tick → wait → waitFor → hittable → expect → shot
 *
 * note у кадра — это подсказка критику, что именно на нём должно быть видно.
 *
 * Кнопки DOM жать `realClick: '#play'`, а не `eval: "...click()"`: DOM-клик
 * проходит сквозь любой слой сверху и прячет перекрытый интерфейс.
 * `hittable: false` у сценария — отказ от проверки кликабельности в конце
 * (например, сценарий заканчивается на открытой модалке).
 */
export default [
  {
    name: 'first-run',
    viewport: 'desktop',
    note: 'Первые 30 секунд глазами нового игрока',
    steps: [
      { wait: 800, shot: '01-title', note: 'Титульный экран: понятно ли, что это за игра и куда нажимать' },
      { click: 'center', wait: 600, shot: '02-start', note: 'Первый экран геймплея' },
      { tick: 600, shot: '03-midgame', note: '10 секунд игры: читается ли происходящее' },
      // `!!x >= 0` всегда истинно — сравнивать надо значение, а не результат
      // приведения к булеву
      { expect: { fn: () => typeof window.__FORGE__?.state().score === 'number', msg: 'состояние доступно' } },
    ],
  },
  {
    name: 'mobile',
    viewport: 'phone',
    note: 'Телефон: не обрезан ли UI, попадают ли пальцы по кнопкам',
    steps: [
      { wait: 800, shot: '01-title' },
      { click: 'center', wait: 600, tick: 300, shot: '02-play' },
    ],
  },
];
