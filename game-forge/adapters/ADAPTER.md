# Adapter contract

An adapter bridges a specific game and the pipeline. Without one, `probe` and
`shots` let an agent inspect and measure the game. With one, `sim`, `analyze`
and `report` let it play hundreds of times and analyze balance.

Place the file at `<game>/forge/adapter.mjs` and reference it in `forge.config.mjs`.

## File shape

```js
export default {
  autostart: true,        // forge calls start() before probe
  tickRate: 60,           // ticks per game second: frames=60, idle ticks=1
  preload({ seed }) {},   // optional: runs BEFORE the game loads
  install() {},           // required: runs AFTER loading and sets window.__FORGE__
}
```

`tickRate` affects reporting only. Without it, 14,400 ticks of an idle game are
reported as “240 seconds” rather than four hours.

`install()` is serialized and executed in the browser. Its closure does not
survive the transfer: declare everything it needs **inside** the function.

## window.__FORGE__

| Method | Required | Purpose |
|---|---|---|
| `start(opts)` | yes | start a fresh run; `opts = {seed, mode, level, ...}` |
| `tick(n)` | yes | advance `n` logic frames **without rendering** |
| `state()` | yes | `{over, win, score, level, lives, ...}` |
| `act(input)` | for sim | apply a bot decision |
| `bots` | for sim | `{ name: (state, ctx) => input }` |
| `render()` | for shots | render the current frame |
| `sample()` | no | values for progress curves (defaults to `state()`) |
| `events()` | no | run events (see below) |

Policy context: `{seed, tick, memory, lastAction, lastOk, ...params}`.
`memory` begins as an empty object and persists for the entire run, holding
policy state such as targets or cooldowns. `lastOk` says whether the previous
action succeeded (`act()` must return `false` on rejection), so a policy avoids
repeatedly trying a construction action it cannot afford.

## Events

Events are flexible, but analytics recognizes these types out of the box:

```js
{ t, type: 'level_start', level }          // entering a level counts as an attempt
{ t, type: 'level_clear', level, ticks }   // ticks spent completing it
{ t, type: 'level_fail',  level, cause }   // failed level: the other denominator component
{ t, type: 'death',       level, cause }   // life lost; excluded from the denominator
{ t, type: 'damage',      level, source, value }
{ t, type: 'reward',      level, kind, value }
```

The distinction between `death` and `level_fail` matters: an arcade player can
lose three lives on one level and still complete it. Counting deaths as attempts
understates completion rates.

Without `level_start`/`level_clear`/`death`, only per-bot win rates are available,
not the difficulty curve or heatmap.

## Game requirements

1. **Fixed step.** `tick()` advances logic by one frame regardless of wall-clock
   time. If the game depends on rAF `delta`, extract `update(dt)` and call it
   with a constant.
2. **No rendering inside tick().** Rendering consumes about 90% of the time;
   disabling it lets 1,000 runs finish in seconds rather than hours.
3. **Determinism.** `Math.random` is already replaced by a seeded generator.
   Seed any custom RNG in `start()` too, so runs with the same seed agree and
   fixes can be verified.
4. **No wall-clock timers** in game logic (`setTimeout`, `Date.now()`): in
   simulation they do not advance along with ticks.

## Minimum bot set

Keep at least two profiles:

- `casual`: infrequent reactions (every 8–12 frames), noticeable aiming error.
- `veteran`: reacts every frame, small errors, uses advanced techniques.

The gap answers whether skill affects the outcome. Without a gap, analytics
raises `skill-flat`.

## Adapter limitations

The adapter does not evaluate enjoyment. It supplies numbers for walls, low
resistance and spikes. Decisions such as increasing damage or removing a wave
remain with a person.
