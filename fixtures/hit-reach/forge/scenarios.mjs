/**
 * Достижимость: где проверка обязана докрутить и попасть, а где — назвать,
 * почему игрок не попадёт. Здоровые сценарии обязаны проходить на телефоне и
 * на десктопе: ложный красный здесь блокировал бы любую страницу со списком.
 */
const reachable = (vp) => ({
  name: `reach-${vp}`,
  viewport: vp,
  note: 'Широкая страница, список с прокруткой, кнопка ниже экрана и кнопка, которая включится позже',
  steps: [
    { realClick: '#pan' },
    { realClick: '#inlist' },
    { realClick: '#below' },
    { realClick: '#late' },
    { realClick: '#buy' },
    { realClick: '#full' },
    { realClick: '#abs' },
    { realClick: '#sb' },
    { expect: { fn: () => ['pan', 'inlist', 'below', 'late', 'buy', 'full', 'abs', 'sb'].every((id) => window.clicks[id] === 1), msg: 'каждый клик дошёл до своей кнопки' } },
    // Проверка без клика — после неё прокрутка возвращается как была
    { eval: 'window.scrollTo(0, 0); document.getElementById("shop").scrollTop = 0' },
    { hittable: ['#buy', '#below'], timeout: 0 },
    { expect: { fn: () => window.scrollY === 0 && document.getElementById('shop').scrollTop === 0, msg: 'проверка не сдвинула прокрутку' } },
  ],
});

export default [
  reachable('phone'),
  reachable('desktop'),
  {
    name: 'pulse',
    viewport: 'desktop',
    note: 'Вечная анимация не должна тормозить клик: ожидание «элемент замер» тут бесконечно',
    steps: [
      { eval: 'window.t0 = performance.now()' },
      { realClick: '#pulse', times: 3 },
      { expect: { fn: () => window.clicks.pulse === 3 && performance.now() - window.t0 < 1500, msg: 'три клика меньше чем за 1,5 с' } },
    ],
  },
  { name: 'locked', viewport: 'phone', steps: [{ hittable: '#inlocked' }] },
  {
    name: 'page-locked',
    viewport: 'desktop',
    // Игра заперла прокрутку страницы, а кнопка уехала ниже экрана
    steps: [{ eval: "document.body.style.overflow = 'hidden'; window.scrollTo(0, 0)" }, { hittable: '#below' }],
  },
  { name: 'dead', viewport: 'desktop', steps: [{ realClick: '#dead', timeout: 800 }] },
  {
    name: 'quiet-check',
    viewport: 'desktop',
    note: 'Чистая проверка докручивает список и возвращает — игра не должна услышать ни одного scroll',
    steps: [
      { eval: 'document.getElementById("list").scrollTop = 0; window.scrolls = 0' },
      { hittable: '#inlist', timeout: 0, wait: 300 },
      { expect: { fn: () => window.scrolls === 0 && document.getElementById('list').scrollTop === 0, msg: 'ни одного scroll, прокрутка на месте' } },
    ],
  },
  {
    name: 'body-free',
    viewport: 'desktop',
    note: 'html заперт, body листается: кнопка ниже экрана достижима, прокрутка body возвращается',
    steps: [
      { eval: 'window.fullscreenCss(true)' },
      { hittable: '#below', timeout: 0 },
      { expect: { fn: () => document.body.scrollTop === 0, msg: 'прокрутка body вернулась' } },
      { realClick: '#below' },
      { expect: { fn: () => window.clicks.below === 1, msg: 'клик дошёл' } },
    ],
  },
  { name: 'body-locked', viewport: 'desktop', steps: [{ eval: 'window.fullscreenCss(false)' }, { hittable: '#below', timeout: 0 }] },
  {
    name: 'fail-shot-scrolled',
    viewport: 'desktop',
    note: 'Перекрытая кнопка ниже экрана: кадр провала снимается там, где перекрытие видно',
    steps: [
      { eval: `const b = document.getElementById('below').getBoundingClientRect();
        const v = document.createElement('div');
        Object.assign(v.style, { position: 'absolute', left: (b.left + scrollX) + 'px', top: (b.top + scrollY) + 'px',
          width: b.width + 'px', height: b.height + 'px', zIndex: 9 });
        v.id = 'cover'; document.body.appendChild(v); window.scrollTo(0, 0);` },
      { hittable: '#below', timeout: 0 },
      // Посреди сценария провал прокрутку не оставляет: дальше идут шаги
      { expect: { fn: () => window.scrollY === 0, msg: 'после провала посреди сценария прокрутка на месте' } },
      // Следующий шаг листает тот же список, что проверка крутила туда и
      // обратно, — его прокрутка обязана дойти до игры
      { eval: 'document.getElementById("list").scrollTop = 0; window.scrolls = 0' },
      { hittable: '#inlist', timeout: 0 },
      { eval: 'document.getElementById("list").scrollTop = 40', wait: 300 },
      { expect: { fn: () => window.scrolls >= 1, msg: 'настоящая прокрутка после проверки дошла до игры' } },
    ],
    // В конце сценария — докрутка к перекрытию для кадра провала
    hittable: ['#below'],
  },
  { name: 'bad-selector', viewport: 'desktop', steps: [{ realClick: 'div[' }] },
  {
    name: 'late-cover',
    viewport: 'desktop',
    note: 'В конце сценария кнопка свободна; накроют её позже — probe обязан судить там же, где play',
    hittable: ['#later'],
    steps: [{ eval: 'window.coverLaterIn(2500)' }],
  },
];
