export default {
  name: 'My game',

  // static root and entry file
  root: '.',
  entry: 'index.html',

  // desktop | wide | portrait | phone | phoneLandscape | tablet
  viewport: 'desktop',

  // continuous: redraw every frame (arcade/action games);
  // on-demand: draw only on events (turn-based or Wordle-like games).
  // In the latter case, no drawing during a measurement window can be normal.
  renderMode: 'continuous',

  // Choose the gameplay canvas when there are several. If omitted,
  // use the largest visible canvas (HUD indicators and preloaders are usually smaller).
  // canvasSelector: '#game',

  // optional: probe and shots work without these, but sim needs an adapter
  adapter: './forge/adapter.mjs',
  scenarios: './forge/scenarios.mjs',

  // controls that must remain reachable for a real player: play/shots
  // check them after scenarios and across viewports (see README)
  // hittable: {
  //   selectors: ['#play', '#shop'],
  //   viewports: ['desktop', 'phoneLandscape', 'phone'],
  //   setup: [],   // setup steps leading to the state where controls must be reachable
  // },

  // art-critic references (screenshots of target-quality games)
  references: 'forge/references',

  // thresholds used to decide whether a run fails
  budgets: {
    frameMs: 16.7,   // main-thread work per frame at 60 fps
    errors: 0,
    bundleKb: 8000,
    loadMs: 3000,
    // drawCalls: 150,  // for 3D: a proxy for GPU load not captured by frameMs
  },
};
