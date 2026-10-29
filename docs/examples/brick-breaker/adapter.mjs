/**
 * Brick Breaker adapter for game-forge.
 *
 * The game is one file with global variables and a fixed step (frame = tick),
 * so the bridge is thin: update() advances logic and mouseX steers the paddle.
 */
export default {
  autostart: true,

  install() {
    const W = 480;                 // MAX_W
    const PADDLE_Y = 700 - 40;     // MAX_H - 40
    const events = [];
    let prevLevel = 1;
    let prevLives = 3;
    let levelStartTick = 0;
    let tickNo = 0;
    let targetLevel = 20;          // LEVELS.length: clearing all levels wins
    let mode = 0;

    /** Predict the ball position at paddle height, including wall bounces. */
    function predictX(ball) {
      if (!ball || ball.dy <= 0) return null;
      const dist = PADDLE_Y - ball.y;
      if (dist <= 0) return null;
      const t = dist / ball.dy;
      let x = ball.x + ball.dx * t;
      // Reflect the trajectory by folding it across the field width.
      const span = 2 * W;
      x = ((x % span) + span) % span;
      if (x > W) x = span - x;
      return { x, ticks: t };
    }

    /** Follow the ball that will land first. */
    function threat() {
      const balls = window.balls || [];
      let best = null;
      for (const b of balls) {
        const p = predictX(b);
        if (!p) continue;
        if (!best || p.ticks < best.ticks) best = { ...p, ball: b };
      }
      return best;
    }

    function aliveBricks() {
      const bricks = window.bricks || [];
      let n = 0;
      for (const b of bricks) if (b.alive) n++;
      return n;
    }

    window.__FORGE__ = {
      version: 1,
      ready: true,

      start(opts = {}) {
        events.length = 0;
        tickNo = 0;
        levelStartTick = 0;
        mode = opts.mode ?? 0;
        targetLevel = opts.targetLevel ?? (window.LEVELS ? window.LEVELS.length : 20);
        window.useKeyboard = false;
        window.inMenu = false;
        window.gameMode = mode;
        window.initGame();
        window.launchBall();
        prevLevel = window.level;
        prevLives = window.lives;
        events.push({ t: 0, type: 'level_start', level: window.level });
      },

      tick(n = 1) {
        for (let i = 0; i < n; i++) {
          if (window.gameOver || window.gameWon) return;
          // The ball sticks after losing a life; a human player restarts immediately.
          if (!window.launched) window.launchBall();
          window.update();
          tickNo++;

          if (window.lives < prevLives) {
            events.push({ t: tickNo, type: 'death', level: prevLevel, cause: 'ball_lost' });
            prevLives = window.lives;
          }
          if (window.level !== prevLevel) {
            events.push({ t: tickNo, type: 'level_clear', level: prevLevel, ticks: tickNo - levelStartTick });
            prevLevel = window.level;
            levelStartTick = tickNo;
            // Past targetLevel the game is already won: a started level 21 would
            // appear in statistics as a wall with zero completion rate.
            if (!(mode === 0 && window.level > targetLevel)) {
              events.push({ t: tickNo, type: 'level_start', level: window.level });
            }
          }
          if (window.gameOver) {
            events.push({ t: tickNo, type: 'run_end', level: window.level, cause: 'game_over' });
            return;
          }
          if (mode === 0 && window.level > targetLevel) {
            events.push({ t: tickNo, type: 'run_end', level: window.level, cause: 'win' });
            return;
          }
        }
      },

      render() { window.draw(); },

      state() {
        const won = mode === 0 && window.level > targetLevel;
        return {
          over: !!window.gameOver || won,
          win: won,
          score: window.score | 0,
          level: window.level | 0,
          lives: window.lives | 0,
          bricks: aliveBricks(),
          balls: (window.balls || []).length,
          speed: +((window.balls || [])[0]?.speed ?? 0).toFixed(2),
          combo: window.combo | 0,
          reversed: (window.reverseTimer | 0) > 0,
          paddleX: Math.round(window.paddle?.x ?? 0),
        };
      },

      sample() {
        const s = this.state();
        return { score: s.score, level: s.level, lives: s.lives, bricks: s.bricks, speed: s.speed };
      },

      events() { return events.slice(); },

      /** Steering is mouseX in game coordinates; the game moves the paddle. */
      act(input) {
        if (input && typeof input.x === 'number') {
          window.mouseX = Math.max(0, Math.min(W, input.x));
        }
      },

      bots: {
        /**
         * Beginner: checks the ball every ~10 frames, misses, does not understand
         * reversed controls and does not collect power-ups.
         */
        casual(state, ctx) {
          const m = ctx.memory;
          m.every = m.every ?? 10;
          m.err = m.err ?? 26;
          if (ctx.tick % m.every !== 0 && m.target != null) return { x: m.target };
          const t = threat();
          if (!t) return m.target != null ? { x: m.target } : { x: W / 2 };
          m.target = t.x + (Math.random() * 2 - 1) * m.err;
          return { x: m.target };
        },

        /** Average player: reacts often, makes moderate errors, notices reversal. */
        normal(state, ctx) {
          const m = ctx.memory;
          if (ctx.tick % 4 !== 0 && m.target != null) return { x: m.target };
          const t = threat();
          if (!t) return { x: W / 2 };
          let x = t.x + (Math.random() * 2 - 1) * 10;
          if (state.reversed) x = W - x;
          m.target = x;
          return { x };
        },

        /**
         * Veteran: reacts every frame with almost no error. Uses the paddle edge
         * to adjust the angle only while the ball is far away: the paddle follows
         * its target exponentially (lerp 0.12), so a clever late adjustment
         * causes a miss. Simulation confirmed that chasing power-ups with an
         * offset of 0.22 times the width made the veteran WORSE than casual.
         */
        veteran(state, ctx) {
          const t = threat();
          if (!t) return { x: W / 2 };
          let x = t.x + (Math.random() * 2 - 1) * 2;
          const pw = window.PADDLE_W ?? 80;
          const ball = t.ball;

          // A nearly vertical ball gets trapped in an empty column forever
          // (verified: 150,000 frames, 8 bricks, zero progress). A human hits
          // it with the paddle edge in this situation, and so does the bot.
          const vertical = ball && Math.abs(ball.dx) < 0.35 * (ball.speed || 1);
          if (vertical) {
            const bricks = window.bricks || [];
            let sum = 0, n = 0;
            for (const b of bricks) if (b.alive) { sum += b.x + b.w / 2; n++; }
            const aim = n ? sum / n : W / 2;         // aim where bricks remain
            x += (aim < ball.x ? -1 : 1) * pw * 0.4;
          } else if (t.ticks > 90) {
            const bricks = window.bricks || [];
            let left = 0, right = 0;
            for (const b of bricks) if (b.alive) (b.x < W / 2 ? left++ : right++);
            x += (left > right ? -1 : 1) * pw * 0.10;
          }
          if (state.reversed) x = W - x;
          return { x };
        },
      },
    };
  },
};
