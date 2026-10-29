/**
 * Scenarios: what forge plays through and when it captures screenshots.
 * Step keys are applied in this order: goto → forge → eval → click → realClick →
 * move → key → type → tick → wait → waitFor → hittable → expect → shot
 *
 * A screenshot note tells the critic what the frame should show.
 *
 * Press DOM buttons with `realClick: '#play'` rather than `eval: "...click()"`:
 * programmatic DOM clicks pass through overlays and hide blocked controls.
 * Set `hittable: false` to skip the end-of-scenario reachability check
 * (for example, when a scenario ends with an open modal).
 */
export default [
  {
    name: 'first-run',
    viewport: 'desktop',
    note: "The first 30 seconds from a new player's perspective",
    steps: [
      { wait: 800, shot: '01-title', note: 'Title screen: is the game concept and next action clear?' },
      { click: 'center', wait: 600, shot: '02-start', note: 'First gameplay screen' },
      { tick: 600, shot: '03-midgame', note: 'Ten seconds in: is the action readable?' },
      // `!!x >= 0` is always true; compare the value rather than its
      // boolean coercion
      { expect: { fn: () => typeof window.__FORGE__?.state().score === 'number', msg: 'state is available' } },
    ],
  },
  {
    name: 'mobile',
    viewport: 'phone',
    note: 'Phone: check for clipped UI and reachable touch targets',
    steps: [
      { wait: 800, shot: '01-title' },
      { click: 'center', wait: 600, tick: 300, shot: '02-play' },
    ],
  },
];
