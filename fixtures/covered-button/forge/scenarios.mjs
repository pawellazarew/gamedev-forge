/**
 * Both sides of the gate on one page. Healthy scenarios must pass:
 * false failures block work just as false passes let defects through.
 * Broken scenarios must fail and identify the covering layer.
 */
export default [
  {
    name: 'click-ok',
    viewport: 'desktop',
    note: 'Artwork ignores input — two real mouse clicks reach the button',
    steps: [
      { eval: 'window.__game.safe()' },
      { realClick: '#go', times: 2 },
      { expect: { fn: () => window.clicks === 2, msg: 'both clicks reached the button' } },
      { expect: { fn: () => window.lastPointer === 'mouse', msg: 'desktop uses a mouse click' } },
    ],
  },
  {
    name: 'tap-ok',
    viewport: 'phone',
    note: 'The same on a phone, using touch',
    steps: [
      { eval: 'window.__game.safe()' },
      { realClick: '#go' },
      { expect: { fn: () => window.clicks === 1, msg: 'touch reached the button' } },
      { expect: { fn: () => window.lastPointer === 'touch', msg: 'phone uses touch rather than a mouse' } },
    ],
  },
  {
    name: 'second-click-covered',
    viewport: 'desktop',
    note: 'First click passes because the tutorial raised the button; second hits artwork',
    steps: [{ realClick: '#go', times: 2 }],
  },
  {
    name: 'dom-click-hides-it',
    viewport: 'desktop',
    note: 'DOM clicks bypass artwork and steps pass; only the end-of-scenario check detects it',
    steps: [
      { eval: 'window.__game.clickGo(); window.__game.clickGo()' },
      { expect: { fn: () => window.clicks === 2, msg: 'DOM clicks registered through the artwork' } },
    ],
  },
  {
    name: 'opted-out',
    viewport: 'desktop',
    // A scenario ending with an open modal legitimately covers the interface
    // and opts out of the end-of-scenario check.
    hittable: false,
    steps: [{ eval: 'window.__game.clickGo()' }],
  },
];
