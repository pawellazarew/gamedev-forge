/**
 * Minimal reference adapter: exactly the ADAPTER.md contract, with no
 * extra features. CI uses it to verify that probe, play and sim all work
 * without errors.
 */
export default {
  autostart: true,
  tickRate: 60,

  install() {
    const events = [];
    let tickNo = 0;
    let prevLevel = 1;
    let prevLives = 3;
    let levelStart = 0;

    window.__FORGE__ = {
      version: 1,
      ready: true,

      start(opts = {}) {
        events.length = 0;
        tickNo = 0;
        levelStart = 0;
        window.__TINY__.reset(opts);
        prevLevel = 1;
        prevLives = 3;
        events.push({ t: 0, type: 'level_start', level: 1 });
      },

      tick(n = 1) {
        const g = window.__TINY__;
        for (let i = 0; i < n; i++) {
          const before = g.state();
          if (before.over) return;
          g.update();
          tickNo++;
          const s = g.state();

          if (s.lives < prevLives) {
            // Losing a life is not failing the level and does not count as an attempt.
            events.push({ t: tickNo, type: 'death', level: prevLevel, cause: 'block_missed' });
            prevLives = s.lives;
          }
          if (s.level !== prevLevel) {
            events.push({ t: tickNo, type: 'level_clear', level: prevLevel, ticks: tickNo - levelStart });
            prevLevel = s.level;
            levelStart = tickNo;
            if (!s.over) events.push({ t: tickNo, type: 'level_start', level: s.level });
          }
          if (s.over) {
            if (!s.won) events.push({ t: tickNo, type: 'level_fail', level: prevLevel, cause: 'out_of_lives' });
            events.push({ t: tickNo, type: 'run_end', level: prevLevel, cause: s.won ? 'win' : 'game_over' });
            return;
          }
        }
      },

      render() { window.__TINY__.draw(); },

      state() {
        const s = window.__TINY__.state();
        return {
          over: s.over, win: s.won, score: s.score, level: s.level, lives: s.lives,
          blocks: s.blocks.length,
          nearest: s.blocks.length ? Math.round(s.blocks.reduce((a, b) => (b.y > a.y ? b : a), s.blocks[0]).x) : null,
        };
      },

      sample() {
        const s = this.state();
        return { score: s.score, level: s.level, lives: s.lives };
      },

      events() { return events.slice(); },

      act(input) {
        if (input && typeof input.x === 'number') { window.__TINY__.setBasket(input.x); return true; }
        return false;
      },

      bots: {
        /** Reacts every 12 frames and misses, like a distracted player. */
        casual(state, ctx) {
          const m = ctx.memory;
          if (ctx.tick % 12 !== 0 && m.x != null) return { x: m.x };
          if (state.nearest == null) return null;
          m.x = state.nearest + (Math.random() * 2 - 1) * 30;
          return { x: m.x };
        },
        /** Reacts every frame with almost no error. */
        veteran(state) {
          if (state.nearest == null) return null;
          return { x: state.nearest + (Math.random() * 2 - 1) * 3 };
        },
      },
    };
  },
};
