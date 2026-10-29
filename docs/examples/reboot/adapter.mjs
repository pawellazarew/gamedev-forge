/**
 * REBOOT: Last Engineer adapter for game-forge.
 *
 * The Phaser 3 game has a one-second idle tick (IdleSystem.tick() in MainScene).
 * One forge tick is one game second, so --max-ticks 14400 represents 4 hours
 * of game time.
 *
 * A run does NOT restart the scene: the Phaser lifecycle requires frames,
 * while simulation disables rendering. Instead, system state is reset
 * directly, as in MainScene._initNewGame().
 */
export default {
  autostart: true,

  // One tick = one game second (IDLE_TICK_MS = 1000), not one frame.
  tickRate: 1,

  install() {
    const SAVE_KEY = 'reboot_last_engineer_save';
    const MATERIALS = ['steel', 'copper', 'polymer', 'silicon', 'batteries'];
    const COMPONENTS = ['microchips', 'servomotors', 'ai_cores', 'nanomaterial'];

    // Progression stages act as levels: analysis plots their difficulty
    // curve and shows where the player gets stuck.
    const MILESTONES = [
      { level: 1, name: 'first_gatherer', test: (s) => s.robots >= 1 },
      { level: 2, name: 'workshop', test: (s) => s.buildingsByType.workshop >= 1 },
      { level: 3, name: 'scrap_100', test: (s) => s.res.scrap >= 100 },
      { level: 4, name: 'generator', test: (s) => s.buildingsByType.generator >= 1 },
      { level: 5, name: 'first_material', test: (s) => MATERIALS.some((m) => s.res[m] > 0) },
      { level: 6, name: 'laboratory', test: (s) => s.buildingsByType.laboratory >= 1 },
      { level: 7, name: 'first_research', test: (s) => s.researched >= 1 },
      { level: 8, name: 'first_component', test: (s) => COMPONENTS.some((c) => s.res[c] > 0) },
    ];

    const events = [];
    let tickNo = 0;
    let stage = 0;
    let stageStart = 0;
    let robotSeq = 0;

    const game = () => window.__PHASER_GAME__;
    const main = () => game()?.scene?.getScene('MainScene');

    /**
     * Start MainScene without waiting for frames. Phaser creates scenes only
     * inside a game step, but simulation disables rAF, so we call
     * game.loop.step() manually. Scenarios still start from the menu like
     * a real player, rather than teleporting into the game on load.
     */
    function ensureMainScene() {
      const g = game();
      if (!g) throw new Error('__PHASER_GAME__ missing — game did not load');
      if (main()?.resourceSystem && g.scene.isActive('MainScene')) return;

      g.scene.stop('MenuScene');
      g.scene.start('MainScene', { isNewGame: true });

      const now = () => performance.now();
      for (let i = 0; i < 20 && !(main()?.resourceSystem && g.scene.isActive('MainScene')); i++) {
        g.loop.step(now() + i);
      }
      if (!main()?.resourceSystem) throw new Error('MainScene did not start within 20 steps');
    }

    function snapshot() {
      const m = main();
      if (!m?.resourceSystem) return null;
      const res = {};
      for (const r of m.resourceSystem.getAll()) res[r.id] = r.amount;
      const buildingsByType = {};
      for (const b of m.buildingSystem.getAll()) {
        buildingsByType[b.type] = (buildingsByType[b.type] || 0) + 1;
      }
      const robots = m.robotSystem.getAll();
      const tech = m.techTreeSystem.exportState();
      return {
        res,
        buildingsByType,
        buildings: m.buildingSystem.getAll().length,
        robots: robots.length,
        gatherers: robots.filter((r) => r.role === 'gatherer').length,
        assigned: robots.filter((r) => r.currentTask?.type === 'gather').length,
        researched: (tech.researched || []).length,
        researching: !!tech.currentResearch,
        craftQueued: m.buildingSystem.getAll().reduce((a, b) => a + (b.craftQueue?.length || 0), 0),
        capacity: m.resourceSystem.getCapacity('scrap'),
      };
    }

    window.__FORGE__ = {
      version: 1,
      ready: false,

      start(opts = {}) {
        ensureMainScene();
        const m = main();
        if (!m) throw new Error('MainScene is not ready');
        events.length = 0;
        tickNo = 0;
        stage = 0;
        stageStart = 0;
        robotSeq = 0;

        try { localStorage.removeItem(SAVE_KEY); } catch { /* private browsing */ }

        // Same as MainScene._initNewGame(), without restarting the scene:
        // Phaser starts scenes over frames, but simulation has no frames.
        m.resourceSystem.init();
        m.buildingSystem.init();
        m.robotSystem.init();
        m.techTreeSystem.init();
        m.resourceSystem.add('scrap', opts.scrap ?? 20);
        m.resourceSystem.add('wires', opts.wires ?? 10);
        m.resourceSystem.add('plastic', opts.plastic ?? 5);
        m.resourceSystem.add('energy', opts.energy ?? 50);

        events.push({ t: 0, type: 'level_start', level: 1 });
      },

      tick(n = 1) {
        const m = main();
        if (!m) return;
        for (let i = 0; i < n; i++) {
          // Call exactly what the game calls: if something does not tick in
          // production (for example, the tech tree), simulation must expose
          // the defect rather than compensate for it.
          m.idleSystem.tick();
          tickNo++;

          const s = snapshot();
          if (!s) continue;
          while (stage < MILESTONES.length && MILESTONES[stage].test(s)) {
            const ms = MILESTONES[stage];
            events.push({ t: tickNo, type: 'level_clear', level: ms.level, ticks: tickNo - stageStart, name: ms.name });
            stage++;
            stageStart = tickNo;
            if (stage < MILESTONES.length) {
              events.push({ t: tickNo, type: 'level_start', level: MILESTONES[stage].level });
            }
          }
          if (stage >= MILESTONES.length) {
            events.push({ t: tickNo, type: 'run_end', level: stage, cause: 'win' });
            return;
          }
        }
      },

      render() { /* Phaser renders while scene frames are running. */ },

      state() {
        const s = snapshot();
        if (!s) return { over: true, win: false, score: 0, level: 0, error: 'no-scene' };
        const total = Object.values(s.res).reduce((a, b) => a + b, 0);
        // Score = progress, not a resource pile: otherwise hoarding without
        // building wins despite lagging behind in progression stages.
        // IMPORTANT: stage counts COMPLETED stages; level is the current number:
        // level = stage + 1. Use stagesCleared: level 6 means five stages
        // completed and the sixth in progress, not six completed stages.
        const score = stage * 10000 + Math.round(total / 10);
        return {
          over: stage >= MILESTONES.length,
          win: stage >= MILESTONES.length,
          score,
          level: stage + 1,
          stagesCleared: stage,
          stageName: MILESTONES[Math.min(stage, MILESTONES.length - 1)].name,
          seconds: tickNo,
          scrap: Math.round(s.res.scrap || 0),
          energy: Math.round(s.res.energy || 0),
          robots: s.robots,
          gatherers: s.gatherers,
          assigned: s.assigned,
          buildings: s.buildings,
          researched: s.researched,
          researching: s.researching,
          capacity: s.capacity,
          full: s.res.scrap >= s.capacity * 0.9 || (s.res.concrete || 0) >= s.capacity * 0.9,
          wires: Math.round(s.res.wires || 0),
          data: Math.round(s.res.data || 0),
          storages: s.buildingsByType.storage || 0,
          smelters: s.buildingsByType.smelter || 0,
          concrete: Math.round(s.res.concrete || 0),
          crafting: s.craftQueued,
          steel: Math.round(s.res.steel || 0),
          copper: Math.round(s.res.copper || 0),
          silicon: Math.round(s.res.silicon || 0),
          sand: Math.round(s.res.sand || 0),
        };
      },

      sample() {
        const st = this.state();
        return {
          score: st.score, level: st.level, scrap: st.scrap, energy: st.energy,
          robots: st.robots, buildings: st.buildings,
        };
      },

      events() { return events.slice(); },

      /**
       * Bot actions. Prices are deliberately not hardcoded: the bot attempts
       * an action and checks its result, surviving changes to game balance.
       */
      act(input) {
        const m = main();
        if (!m || !input) return false;
        switch (input.type) {
          case 'robot': {
            const r = m.robotSystem.create(`R-${++robotSeq}`, input.role || 'gatherer');
            if (r) m.robotSystem.assignTask(r.id, { type: 'gather', targetId: input.target || 'scrap', progress: 0 });
            return !!r;
          }
          case 'assign': {
            const idle = m.robotSystem.getAll().filter((r) => !r.currentTask || r.currentTask.type === 'idle');
            let ok = false;
            for (const r of idle) {
              ok = m.robotSystem.assignTask(r.id, { type: 'gather', targetId: input.target || 'scrap', progress: 0 }) || ok;
            }
            return ok;
          }
          case 'spread': {
            // Assign gatherers cyclically across targets. Idempotent:
            // returns true when the resulting assignment matches the list,
            // rather than when anything changed; otherwise the policy would
            // treat an already-correct assignment as a failure.
            const targets = input.targets || ['scrap', 'concrete'];
            const all = m.robotSystem.getAll();
            if (!all.length) return false;
            all.forEach((r, i) => {
              const t = targets[i % targets.length];
              if (r.currentTask?.targetId !== t || r.currentTask?.type !== 'gather') {
                m.robotSystem.assignTask(r.id, { type: 'gather', targetId: t, progress: 0 });
              }
            });
            return true;
          }
          case 'build': {
            const n = m.buildingSystem.getAll().length;
            return !!m.buildingSystem.build(input.building, 4 + (n % 8) * 2, 4 + Math.floor(n / 8) * 2);
          }
          case 'upgrade': {
            const list = m.buildingSystem.getByType(input.building);
            return list.length ? m.buildingSystem.upgrade(list[0].id) : false;
          }
          case 'research': {
            return m.techTreeSystem.startResearch(input.tech);
          }
          case 'craft': {
            // Build recipes here: RECIPES lives in a module, not on window.
            // Fields match RecipeDef; the system needs nothing else.
            const recipes = {
              steel: { id: 'recipe_steel', name: 'Steel', input: { scrap: 3 }, outputResource: 'steel', outputAmount: 1, baseTime: 15, energyCost: 1, station: 'smelter' },
              copper: { id: 'recipe_copper', name: 'Copper', input: { wires: 3 }, outputResource: 'copper', outputAmount: 1, baseTime: 20, energyCost: 1, station: 'smelter' },
              polymer: { id: 'recipe_polymer', name: 'Polymer', input: { plastic: 3 }, outputResource: 'polymer', outputAmount: 1, baseTime: 18, energyCost: 1, station: 'smelter' },
              silicon: { id: 'recipe_silicon', name: 'Silicon', input: { sand: 2 }, outputResource: 'silicon', outputAmount: 1, baseTime: 30, energyCost: 3, station: 'smelter' },
            };
            const recipe = recipes[input.recipe || 'steel'];
            if (!recipe) return false;
            const b = m.buildingSystem.findAvailableCraftBuilding(recipe.station)
              || m.buildingSystem.getByType('smelter')[0];
            return b ? m.buildingSystem.addToCraftQueue(b.id, recipe) : false;
          }
          default:
            return false;
        }
      },

      bots: {
        /** Baseline: player opens the game and leaves. Measures pure idle progress. */
        afk() { return null; },

        /**
         * Ablation: saves exclusively for the Laboratory without crafting.
         * Separates the game blocking progress from the optimizer policy
         * wasting resources; otherwise a wall at stage 6 cannot be
         * demonstrated.
         */
        lab_rush(state, ctx) {
          if (ctx.tick % 3 !== 0) return null;
          const m = ctx.memory;
          const key = ctx.lastAction ? `${ctx.lastAction.type}_${ctx.lastAction.building || ''}` : null;
          if (ctx.lastOk === false && key) m[`fail_${key}`] = ctx.tick;
          const failed = (k) => ctx.tick - (m[`fail_${k}`] ?? -1e9) < 900;

          const need = [];
          if (state.concrete < 60) need.push('concrete');
          need.push('scrap');
          if (m.focus !== need.join(',')) { m.focus = need.join(','); return { type: 'spread', targets: need }; }
          if (state.assigned < state.robots) return { type: 'spread', targets: need };
          if (state.robots < 8 && !failed('robot_')) return { type: 'robot', role: 'gatherer' };
          if (state.full && !failed('build_storage')) return { type: 'build', building: 'storage' };
          if (!failed('build_laboratory')) return { type: 'build', building: 'laboratory' };
          return null;
        },

        /**
         * Sensible player: splits gatherers between scrap and concrete,
         * builds storage when reaching the capacity limit.
         * Acts every 5 game seconds, like a person without a stopwatch.
         */
        builder(state, ctx) {
          if (ctx.tick % 5 !== 0) return null;
          const m = ctx.memory;
          if (ctx.lastOk === false && ctx.lastAction) m[`fail_${ctx.lastAction.type}`] = ctx.tick;
          const failed = (t) => ctx.tick - (m[`fail_${t}`] ?? -1e9) < 600;

          if (state.robots < 3 && !failed('robot')) return { type: 'robot', role: 'gatherer' };
          // Reassign whenever the robot count grows: new robots start gathering
          // scrap and will not switch to concrete on their own.
          if (m.spreadFor !== state.robots || state.assigned < state.robots) {
            m.spreadFor = state.robots;
            return { type: 'spread', targets: ['scrap', 'concrete'] };
          }
          if (state.full && !failed('build')) return { type: 'build', building: 'storage' };
          return null;
        },

        /**
         * Optimizer: assigns gathering to the resource chain, expands storage,
         * builds the Smelter and starts steel production. If this player
         * cannot progress either, the limitation is the game rather than skill.
         */
        optimizer(state, ctx) {
          if (ctx.tick % 3 !== 0) return null;
          const m = ctx.memory;
          const key = ctx.lastAction ? `${ctx.lastAction.type}_${ctx.lastAction.building || ctx.lastAction.recipe || ''}` : null;
          if (ctx.lastOk === false && key) m[`fail_${key}`] = ctx.tick;
          const failed = (k) => ctx.tick - (m[`fail_${k}`] ?? -1e9) < 900;

          // Use TechId identifiers; invented IDs make startResearch silently return false.
          m.techQueue = m.techQueue ?? ['basic_metallurgy', 'basic_diagnostics', 'expanded_storage'];

          // Gather for the current chain requirement rather than putting everyone on scrap.
          const need = [];
          if (state.concrete < 40) need.push('concrete');
          if (state.wires < 20) need.push('wires');
          // The Laboratory costs 15 steel + 10 copper + 5 silicon: without sand
          // and wires the chain breaks at its second building.
          if (state.sand < 30) need.push('sand');
          if (state.data < 15) need.push('data');
          need.push('scrap');
          const wanted = need.join(',');
          if (m.focus !== wanted) { m.focus = wanted; return { type: 'spread', targets: need }; }
          if (state.assigned < state.robots) return { type: 'spread', targets: need };

          // The storage cap blocks everything else.
          if (state.full && !failed('build_storage')) return { type: 'build', building: 'storage' };
          if (state.robots < 6 && !failed('robot_')) return { type: 'robot', role: 'gatherer' };
          if (!state.smelters && !failed('build_smelter')) return { type: 'build', building: 'smelter' };
          // Craft exactly what is missing for the Laboratory.
          if (state.smelters) {
            if (state.steel < 20 && state.scrap > 20 && !failed('craft_steel')) return { type: 'craft', recipe: 'steel' };
            if (state.copper < 12 && state.wires > 10 && !failed('craft_copper')) return { type: 'craft', recipe: 'copper' };
            if (state.silicon < 8 && state.sand > 10 && !failed('craft_silicon')) return { type: 'craft', recipe: 'silicon' };
          }
          if (!state.researching && m.techQueue.length && !failed('research_')) {
            return { type: 'research', tech: m.techQueue.shift() };
          }
          if (state.scrap > 200 && !failed('build_laboratory')) return { type: 'build', building: 'laboratory' };
          return null;
        },
      },
    };

    window.__FORGE__.ready = true;
  },
};
