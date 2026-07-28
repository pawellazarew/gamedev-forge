/**
 * Адаптер игры для game-forge.
 *
 * install() выполняется ВНУТРИ страницы после загрузки игры. Он не имеет
 * доступа к переменным этого файла — всё нужное объявляй внутри.
 * Задача install(): собрать window.__FORGE__ поверх внутренностей игры.
 *
 * Полный контракт: tools/game-forge/adapters/ADAPTER.md
 */
export default {
  // если игра стартует не сама — forge вызовет __FORGE__.start() перед probe
  autostart: true,

  install() {
    const events = [];
    let lastLevel = null;

    window.__FORGE__ = {
      version: 1,
      ready: true,

      /** Новый прогон с чистого листа. opts: {seed, mode, level, ...} */
      start(opts = {}) {
        events.length = 0;
        // TODO: вызвать инициализацию игры, например:
        // window.inMenu = false; window.initGame();
        lastLevel = null;
      },

      /** Прогнать n логических кадров БЕЗ рендера. */
      tick(n = 1) {
        for (let i = 0; i < n; i++) {
          // TODO: один шаг симуляции игры, например: window.update();
          // Здесь же удобно ловить смену уровня и писать события:
          // const lvl = window.level;
          // if (lvl !== lastLevel) { events.push({t: i, type: 'level_start', level: lvl}); lastLevel = lvl; }
        }
      },

      /** Отрисовать текущее состояние — нужно только для скриншотов. */
      render() {
        // TODO: window.draw();
      },

      /** Снимок состояния. Обязательны over и (для winrate) win. */
      state() {
        return {
          over: false,   // TODO
          win: false,    // TODO
          score: 0,      // TODO
          level: 1,      // TODO
          lives: 0,      // TODO
        };
      },

      /** Что писать в кривые прогресса каждые N кадров. По умолчанию = state(). */
      sample() {
        return this.state();
      },

      /** События прогона: level_start / level_clear / death / damage / reward. */
      events() {
        return events.slice();
      },

      /** Применить решение бота. Формат input определяешь ты сам. */
      act(input) {
        // TODO: например window.mouseX = input.x;
      },

      /**
       * Политики игроков. Каждая: (state, ctx) => input
       * ctx = {seed, tick, memory, ...params}. memory живёт весь прогон.
       * Держи хотя бы casual (медленная реакция) и veteran (быстрая) —
       * разница между ними показывает, влияет ли навык на исход.
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
