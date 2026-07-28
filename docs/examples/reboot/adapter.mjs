/**
 * Адаптер REBOOT: Last Engineer для game-forge.
 *
 * Игра — Phaser 3 с idle-тиком раз в секунду (`IdleSystem.tick()` из MainScene).
 * Один forge-тик = одна игровая секунда, поэтому `--max-ticks 14400` это 4 часа
 * игрового времени.
 *
 * Прогон НЕ перезапускает сцену: жизненный цикл Phaser требует кадров, а в
 * симуляции рендер выключен. Вместо этого состояние систем сбрасывается
 * напрямую — тем же способом, что и `MainScene._initNewGame()`.
 */
export default {
  autostart: true,

  // один тик = одна игровая секунда (IDLE_TICK_MS = 1000), а не кадр
  tickRate: 1,

  install() {
    const SAVE_KEY = 'reboot_last_engineer_save';
    const MATERIALS = ['steel', 'copper', 'polymer', 'silicon', 'batteries'];
    const COMPONENTS = ['microchips', 'servomotors', 'ai_cores', 'nanomaterial'];

    // Стадии прогрессии играют роль «уровней»: аналитика построит по ним
    // кривую сложности и покажет, на чём застревает игрок.
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
     * Поднимает MainScene, не дожидаясь кадров. Phaser создаёт сцену только
     * внутри игрового шага, а в симуляции rAF выключен — поэтому крутим
     * `game.loop.step()` руками. Сценарии при этом стартуют из меню, как
     * настоящий игрок, а не «телепортируются» в игру при загрузке.
     */
    function ensureMainScene() {
      const g = game();
      if (!g) throw new Error('__PHASER_GAME__ нет — игра не загрузилась');
      if (main()?.resourceSystem && g.scene.isActive('MainScene')) return;

      g.scene.stop('MenuScene');
      g.scene.start('MainScene', { isNewGame: true });

      const now = () => performance.now();
      for (let i = 0; i < 20 && !(main()?.resourceSystem && g.scene.isActive('MainScene')); i++) {
        g.loop.step(now() + i);
      }
      if (!main()?.resourceSystem) throw new Error('MainScene не поднялась за 20 шагов');
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
        if (!m) throw new Error('MainScene не готова');
        events.length = 0;
        tickNo = 0;
        stage = 0;
        stageStart = 0;
        robotSeq = 0;

        try { localStorage.removeItem(SAVE_KEY); } catch { /* приватный режим */ }

        // Ровно то же, что делает MainScene._initNewGame(), но без перезапуска
        // сцены: Phaser поднимает сцену по кадрам, а кадров в симуляции нет.
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
          // Вызываем ровно то, что вызывает сама игра: если что-то не тикает
          // в проде (например, тех-дерево), симуляция обязана это показать,
          // а не компенсировать.
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

      render() { /* рендерит сам Phaser: сцена живёт, пока идут кадры */ },

      state() {
        const s = snapshot();
        if (!s) return { over: true, win: false, score: 0, level: 0, error: 'no-scene' };
        const total = Object.values(s.res).reduce((a, b) => a + b, 0);
        // Счёт = прогресс, а не куча ресурсов: иначе выигрывает тот, кто копит
        // и ничего не строит, хотя по стадиям он отстаёт.
        // ВАЖНО: stage — сколько стадий ПРОЙДЕНО, level — номер текущей, то есть
        // level = stage + 1. Смотреть надо на stagesCleared: «уровень 6» значит
        // «пять стадий позади, шестая в работе», а не «шесть пройдено».
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
       * Действия бота. Цены нарочно не зашиты: бот пробует действие и смотрит
       * на результат — так адаптер переживает любую переработку баланса.
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
            // Раскидать добытчиков по списку целей циклически. Идемпотентно:
            // возвращает true, если после вызова распределение соответствует
            // списку, а не «поменялось ли что-то» — иначе политика примет
            // уже правильную расстановку за неудачу.
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
            // Рецепт собираем здесь: RECIPES живут в модуле и в window не попадают.
            // Поля совпадают с RecipeDef — системе больше ничего не нужно.
            const recipes = {
              steel: { id: 'recipe_steel', name: 'Сталь', input: { scrap: 3 }, outputResource: 'steel', outputAmount: 1, baseTime: 15, energyCost: 1, station: 'smelter' },
              copper: { id: 'recipe_copper', name: 'Медь', input: { wires: 3 }, outputResource: 'copper', outputAmount: 1, baseTime: 20, energyCost: 1, station: 'smelter' },
              polymer: { id: 'recipe_polymer', name: 'Полимер', input: { plastic: 3 }, outputResource: 'polymer', outputAmount: 1, baseTime: 18, energyCost: 1, station: 'smelter' },
              silicon: { id: 'recipe_silicon', name: 'Кремний', input: { sand: 2 }, outputResource: 'silicon', outputAmount: 1, baseTime: 30, energyCost: 3, station: 'smelter' },
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
        /** Базовая линия: игрок открыл игру и ушёл. Сколько даёт чистый idle. */
        afk() { return null; },

        /**
         * Абляция: копит строго на Лабораторию и не отвлекается на крафт.
         * Нужен, чтобы отделить «игра не пускает дальше» от «политика
         * optimizer растрачивает ресурсы» — иначе стена на стадии 6
         * недоказуема.
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
         * Здравый игрок: делит добытчиков между металлоломом и бетоном,
         * ставит склад, когда упирается в потолок хранения.
         * Действует раз в 5 игровых секунд — как человек без секундомера.
         */
        builder(state, ctx) {
          if (ctx.tick % 5 !== 0) return null;
          const m = ctx.memory;
          if (ctx.lastOk === false && ctx.lastAction) m[`fail_${ctx.lastAction.type}`] = ctx.tick;
          const failed = (t) => ctx.tick - (m[`fail_${t}`] ?? -1e9) < 600;

          if (state.robots < 3 && !failed('robot')) return { type: 'robot', role: 'gatherer' };
          // Пересобирать расстановку каждый раз, когда роботов стало больше:
          // новый робот создаётся с задачей на металлолом и сам на бетон не уйдёт
          if (m.spreadFor !== state.robots || state.assigned < state.robots) {
            m.spreadFor = state.robots;
            return { type: 'spread', targets: ['scrap', 'concrete'] };
          }
          if (state.full && !failed('build')) return { type: 'build', building: 'storage' };
          return null;
        },

        /**
         * Игрок, который выжимает из игры всё: распределяет добычу под нужды
         * цепочки, расширяет склад, строит Плавильню и ставит крафт стали.
         * Если и он не двигается дальше — упирается не навык, а сама игра.
         */
        optimizer(state, ctx) {
          if (ctx.tick % 3 !== 0) return null;
          const m = ctx.memory;
          const key = ctx.lastAction ? `${ctx.lastAction.type}_${ctx.lastAction.building || ctx.lastAction.recipe || ''}` : null;
          if (ctx.lastOk === false && key) m[`fail_${key}`] = ctx.tick;
          const failed = (k) => ctx.tick - (m[`fail_${k}`] ?? -1e9) < 900;

          // Идентификаторы из TechId — с выдуманными startResearch молча вернёт false
          m.techQueue = m.techQueue ?? ['basic_metallurgy', 'basic_diagnostics', 'expanded_storage'];

          // Добыча идёт под текущую потребность цепочки, а не «всё в металлолом»
          const need = [];
          if (state.concrete < 40) need.push('concrete');
          if (state.wires < 20) need.push('wires');
          // Лаборатория стоит 15 стали + 10 меди + 5 кремния: без песка и
          // проволоки цепочка обрывается на второй же постройке
          if (state.sand < 30) need.push('sand');
          if (state.data < 15) need.push('data');
          need.push('scrap');
          const wanted = need.join(',');
          if (m.focus !== wanted) { m.focus = wanted; return { type: 'spread', targets: need }; }
          if (state.assigned < state.robots) return { type: 'spread', targets: need };

          // Потолок хранения перекрывает всё остальное
          if (state.full && !failed('build_storage')) return { type: 'build', building: 'storage' };
          if (state.robots < 6 && !failed('robot_')) return { type: 'robot', role: 'gatherer' };
          if (!state.smelters && !failed('build_smelter')) return { type: 'build', building: 'smelter' };
          // Крафтим ровно то, чего не хватает на Лабораторию
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
