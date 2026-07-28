export default [
  {
    name: 'first-run',
    viewport: 'wide',
    note: 'Первые минуты глазами нового игрока: меню → база → первый доход',
    steps: [
      { wait: 1200, shot: '01-menu', note: 'Титульный экран: понятно ли, что это за игра и куда нажимать' },
      { forge: ['start'], wait: 600, shot: '02-base', note: 'База сразу после старта: есть ли на что смотреть, ясно ли первое действие' },
      { forge: ['act', { type: 'robot', role: 'gatherer', target: 'scrap' }] },
      { forge: ['act', { type: 'build', building: 'workshop' }] },
      { forge: ['tick', 60], wait: 400, shot: '03-after-minute', note: 'Минута игры: видно ли, что ресурсы растут и робот работает' },
      { forge: ['tick', 600], wait: 400, shot: '04-after-10min', note: '10 минут: изменилась ли картинка вообще' },
      { expect: { fn: () => window.__FORGE__.state().scrap > 20, msg: 'ресурсы растут за 10 минут игры' } },
      { expect: { fn: () => window.__FORGE__.state().buildings > 0, msg: 'постройка появилась' } },
    ],
  },
  {
    name: 'ui-panels',
    viewport: 'wide',
    note: 'UI-панели поверх карты: ресурсы, роботы, действия, миникарта',
    steps: [
      { forge: ['start'], wait: 500 },
      { forge: ['act', { type: 'robot', role: 'gatherer', target: 'scrap' }] },
      { forge: ['act', { type: 'robot', role: 'builder', target: 'scrap' }] },
      { forge: ['act', { type: 'build', building: 'workshop' }] },
      { forge: ['act', { type: 'build', building: 'generator' }] },
      { forge: ['tick', 300], wait: 500, shot: '01-hud', full: true, note: 'Весь экран: не перекрывают ли панели карту, читается ли иерархия' },
    ],
  },
  {
    name: 'phone',
    viewport: 'phoneLandscape',
    note: 'Телефон в альбомной ориентации — Scale.FIT на 844×390',
    steps: [
      { wait: 1200, shot: '01-menu', full: true },
      { forge: ["start"], wait: 500 },
      { forge: ['tick', 120], wait: 400, shot: '02-base', full: true, note: 'Читаемы ли подписи и иконки на маленьком экране' },
    ],
  },
];
