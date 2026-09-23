/**
 * Обе половины гейта на одной странице. Здоровые сценарии обязаны проходить —
 * ложный красный блокирует работу так же, как ложный зелёный её пропускает.
 * Сломанные обязаны краснеть и называть перекрывающий слой.
 */
export default [
  {
    name: 'click-ok',
    viewport: 'desktop',
    note: 'Арт не ловит клики — настоящий клик мышью доходит до кнопки дважды',
    steps: [
      { eval: 'window.__game.safe()' },
      { realClick: '#go', times: 2 },
      { expect: { fn: () => window.clicks === 2, msg: 'оба клика дошли' } },
      { expect: { fn: () => window.lastPointer === 'mouse', msg: 'на десктопе клик мышью' } },
    ],
  },
  {
    name: 'tap-ok',
    viewport: 'phone',
    note: 'То же на телефоне — касанием',
    steps: [
      { eval: 'window.__game.safe()' },
      { realClick: '#go' },
      { expect: { fn: () => window.clicks === 1, msg: 'касание дошло' } },
      { expect: { fn: () => window.lastPointer === 'touch', msg: 'на телефоне касание, а не мышь' } },
    ],
  },
  {
    name: 'second-click-covered',
    viewport: 'desktop',
    note: 'Первый клик проходит (урок поднял кнопку), второй упирается в арт',
    steps: [{ realClick: '#go', times: 2 }],
  },
  {
    name: 'dom-click-hides-it',
    viewport: 'desktop',
    note: 'DOM-клики проходят сквозь арт, шаги зелёные — ловит только проверка в конце сценария',
    steps: [
      { eval: 'window.__game.clickGo(); window.__game.clickGo()' },
      { expect: { fn: () => window.clicks === 2, msg: 'DOM-клики засчитаны сквозь арт' } },
    ],
  },
  {
    name: 'opted-out',
    viewport: 'desktop',
    // Сценарий, который заканчивается на открытой модалке, законно
    // перекрывает интерфейс и отказывается от проверки в конце.
    hittable: false,
    steps: [{ eval: 'window.__game.clickGo()' }],
  },
];
