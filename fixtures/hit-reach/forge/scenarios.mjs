/**
 * Reachability: where the check must scroll and hit, and where it must
 * explain why a player cannot hit. Healthy scenarios must pass on phones
 * and desktops: a false failure here would block any page with a list.
 */
const reachable = (vp) => ({
  name: `reach-${vp}`,
  viewport: vp,
  note: 'Wide page, scrollable list, below-screen button and a button enabled later',
  steps: [
    { realClick: '#pan' },
    { realClick: '#inlist' },
    { realClick: '#below' },
    { realClick: '#late' },
    { realClick: '#buy' },
    { realClick: '#full' },
    { realClick: '#abs' },
    { realClick: '#sb' },
    { expect: { fn: () => ['pan', 'inlist', 'below', 'late', 'buy', 'full', 'abs', 'sb'].every((id) => window.clicks[id] === 1), msg: 'each click reached its button' } },
    // Check without clicking, then restore the original scroll position.
    { eval: 'window.scrollTo(0, 0); document.getElementById("shop").scrollTop = 0' },
    { hittable: ['#buy', '#below'], timeout: 0 },
    { expect: { fn: () => window.scrollY === 0 && document.getElementById('shop').scrollTop === 0, msg: 'check preserved scroll position' } },
  ],
});

export default [
  reachable('phone'),
  reachable('desktop'),
  {
    name: 'pulse',
    viewport: 'desktop',
    note: 'Continuous animation must not delay clicks: waiting for a stationary element would never end',
    steps: [
      { eval: 'window.t0 = performance.now()' },
      { realClick: '#pulse', times: 3 },
      { expect: { fn: () => window.clicks.pulse === 3 && performance.now() - window.t0 < 1500, msg: 'three clicks in less than 1.5 seconds' } },
    ],
  },
  { name: 'locked', viewport: 'phone', steps: [{ hittable: '#inlocked' }] },
  {
    name: 'page-locked',
    viewport: 'desktop',
    // Game locks page scrolling while the button sits below the screen.
    steps: [{ eval: "document.body.style.overflow = 'hidden'; window.scrollTo(0, 0)" }, { hittable: '#below' }],
  },
  { name: 'dead', viewport: 'desktop', steps: [{ realClick: '#dead', timeout: 800 }] },
  {
    name: 'quiet-check',
    viewport: 'desktop',
    note: 'A check scrolls the list and restores it; the game must receive no scroll events',
    steps: [
      { eval: 'document.getElementById("list").scrollTop = 0; window.scrolls = 0' },
      { hittable: '#inlist', timeout: 0, wait: 300 },
      { expect: { fn: () => window.scrolls === 0 && document.getElementById('list').scrollTop === 0, msg: 'no scroll events and scroll position unchanged' } },
    ],
  },
  {
    name: 'body-free',
    viewport: 'desktop',
    note: 'Locked html, scrollable body: below-screen button is reachable and body scroll is restored',
    steps: [
      { eval: 'window.fullscreenCss(true)' },
      { hittable: '#below', timeout: 0 },
      { expect: { fn: () => document.body.scrollTop === 0, msg: 'body scroll position restored' } },
      { realClick: '#below' },
      { expect: { fn: () => window.clicks.below === 1, msg: 'click reached the button' } },
    ],
  },
  { name: 'body-locked', viewport: 'desktop', steps: [{ eval: 'window.fullscreenCss(false)' }, { hittable: '#below', timeout: 0 }] },
  {
    name: 'fail-shot-scrolled',
    viewport: 'desktop',
    note: 'Covered button below the screen: failure screenshot is captured where the overlay is visible',
    steps: [
      { eval: `const b = document.getElementById('below').getBoundingClientRect();
        const v = document.createElement('div');
        Object.assign(v.style, { position: 'absolute', left: (b.left + scrollX) + 'px', top: (b.top + scrollY) + 'px',
          width: b.width + 'px', height: b.height + 'px', zIndex: 9 });
        v.id = 'cover'; document.body.appendChild(v); window.scrollTo(0, 0);` },
      { hittable: '#below', timeout: 0 },
      // Mid-scenario failure restores scrolling because more steps follow.
      { expect: { fn: () => window.scrollY === 0, msg: 'mid-scenario failure preserved scroll position' } },
      // The next step scrolls the same list previously scrolled and restored
      // by the check; this real scroll event must reach the game.
      { eval: 'document.getElementById("list").scrollTop = 0; window.scrolls = 0' },
      { hittable: '#inlist', timeout: 0 },
      { eval: 'document.getElementById("list").scrollTop = 40', wait: 300 },
      { expect: { fn: () => window.scrolls >= 1, msg: 'real scroll after the check reached the game' } },
    ],
    // End of scenario: scroll to the overlay for the failure screenshot.
    hittable: ['#below'],
  },
  { name: 'bad-selector', viewport: 'desktop', steps: [{ realClick: 'div[' }] },
  {
    name: 'late-cover',
    viewport: 'desktop',
    note: 'Button is clear at scenario end and covered later; probe must check at the same point as play',
    hittable: ['#later'],
    steps: [{ eval: 'window.coverLaterIn(2500)' }],
  },
];
