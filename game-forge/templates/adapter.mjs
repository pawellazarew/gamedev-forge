/**
 * Game adapter for game-forge.
 *
 * install() runs INSIDE the page after the game loads. It cannot access
 * variables from this file; declare everything it needs inside the function.
 * Its job is to expose game internals through window.__FORGE__.
 *
 * Full contract: tools/game-forge/adapters/ADAPTER.md
 */
export default {
  // if the game does not start itself, forge calls __FORGE__.start() before probe
  autostart: true,

  install() {
    const events = [];
    let lastLevel = null;

    window.__FORGE__ = {
      version: 1,
      ready: true,

      /** Start a fresh run. opts: {seed, mode, level, ...} */
      start(opts = {}) {
        events.length = 0;
        // TODO: initialize the game, for example:
        // window.inMenu = false; window.initGame();
        lastLevel = null;
      },

      /** Advance n logic frames WITHOUT rendering. */
      tick(n = 1) {
        for (let i = 0; i < n; i++) {
          // TODO: advance one simulation step, for example: window.update();
          // Detect level changes and emit events here:
          // const lvl = window.level;
          // if (lvl !== lastLevel) { events.push({t: i, type: 'level_start', level: lvl}); lastLevel = lvl; }
        }
      },

      /** Render the current state; needed only for screenshots. */
      render() {
        // TODO: window.draw();
      },

      /** State snapshot. Requires over and, for win rates, win. */
      state() {
        return {
          over: false,   // TODO
          win: false,    // TODO
          score: 0,      // TODO
          level: 1,      // TODO
          lives: 0,      // TODO
        };
      },

      /** Values for progress curves every N frames. Defaults to state(). */
      sample() {
        return this.state();
      },

      /** Run events: level_start / level_clear / death / damage / reward. */
      events() {
        return events.slice();
      },

      /** Apply a bot decision. Define the input format for your game. */
      act(input) {
        // TODO: for example, window.mouseX = input.x;
      },

      /**
       * Player policies. Each takes (state, ctx) and returns input.
       * ctx = {seed, tick, memory, ...params}. memory persists for the entire run.
       * Keep at least casual (slow reactions) and veteran (fast reactions);
       * their gap shows whether skill affects the outcome.
       */
      bots: {
        casual(state, ctx) {
          return null; // TODO
        },
        veteran(state, ctx) {
          return null; // TODO
        },
      },
    };
  },
};
