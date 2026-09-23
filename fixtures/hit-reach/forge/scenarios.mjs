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
    { expect: { fn: () => ['pan', 'inlist', 'below', 'late', 'buy', 'full', 'abs'].every((id) => window.clicks[id] === 1), msg: 'каждый клик дошёл до своей кнопки' } },
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
  { name: 'bad-selector', viewport: 'desktop', steps: [{ realClick: 'div[' }] },
  {
    name: 'late-cover',
    viewport: 'desktop',
    note: 'В конце сценария кнопка свободна; накроют её позже — probe обязан судить там же, где play',
    hittable: ['#later'],
    steps: [{ eval: 'window.coverLaterIn(2500)' }],
  },
];
