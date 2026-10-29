export default [
  {
    name: 'first-run',
    viewport: 'wide',
    note: 'First minutes as a new player: menu → base → first income',
    steps: [
      { wait: 1200, shot: '01-menu', note: 'Title screen: is the game clear and the next action obvious' },
      { forge: ['start'], wait: 600, shot: '02-base', note: 'Base just after starting: is there anything to see, is the first action clear' },
      { forge: ['act', { type: 'robot', role: 'gatherer', target: 'scrap' }] },
      { forge: ['act', { type: 'build', building: 'workshop' }] },
      { forge: ['tick', 60], wait: 400, shot: '03-after-minute', note: 'After one minute: visible resource growth and robot activity' },
      { forge: ['tick', 600], wait: 400, shot: '04-after-10min', note: 'After 10 minutes: has the scene changed at all' },
      { expect: { fn: () => window.__FORGE__.state().scrap > 20, msg: 'resources grow during 10 minutes of play' } },
      { expect: { fn: () => window.__FORGE__.state().buildings > 0, msg: 'a building appears' } },
    ],
  },
  {
    name: 'ui-panels',
    viewport: 'wide',
    note: 'UI panels over the map: resources, robots, actions and minimap',
    steps: [
      { forge: ['start'], wait: 500 },
      { forge: ['act', { type: 'robot', role: 'gatherer', target: 'scrap' }] },
      { forge: ['act', { type: 'robot', role: 'builder', target: 'scrap' }] },
      { forge: ['act', { type: 'build', building: 'workshop' }] },
      { forge: ['act', { type: 'build', building: 'generator' }] },
      { forge: ['tick', 300], wait: 500, shot: '01-hud', full: true, note: 'Full screen: do panels obscure the map, is visual hierarchy readable' },
    ],
  },
  {
    name: 'phone',
    viewport: 'phoneLandscape',
    note: 'Landscape phone — Scale.FIT at 844×390',
    steps: [
      { wait: 1200, shot: '01-menu', full: true },
      { forge: ["start"], wait: 500 },
      { forge: ['tick', 120], wait: 400, shot: '02-base', full: true, note: 'Are labels and icons readable on a small screen' },
    ],
  },
];
