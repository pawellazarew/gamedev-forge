# game-forge

**English** | [Русский](README.ru.md)

A local CLI for browser game checks, screenshots, scripted play and balance
simulations. No AI account is required. See the [repository quick start](../README.md).

## Install

Requires Node.js 22+ on macOS or Linux.

```bash
cd game-forge
npm ci
npx playwright-core install chromium
node bin/forge.mjs doctor
```

For Linux system libraries: `npx playwright-core install --with-deps chromium`.
This repository is installed from source; these instructions do not assume an npm
registry release.

## Commands

Run these from `game-forge/`, replacing `<game>` with a game directory:

```bash
node bin/forge.mjs init <game>
node bin/forge.mjs probe <game> --seconds 8 --strict
node bin/forge.mjs probe <game> --scenario storm-peak --headed
node bin/forge.mjs shots <game> --only first-run
node bin/forge.mjs play <game>
node bin/forge.mjs sim <game> --runs 40 --max-ticks 150000
node bin/forge.mjs analyze <game>
node bin/forge.mjs report <game>
node bin/forge.mjs critique <game>
node bin/forge.mjs all <game> --runs 40
```

| Command | Purpose |
| --- | --- |
| `doctor` | Locate Chromium and check the runtime |
| `init` | Generate configuration, scenarios and an adapter template |
| `probe` | Measure frame work, load size/time, rendering activity and errors |
| `shots` | Capture configured scenarios |
| `play` | Run scenarios and fail on failed checks |
| `sim` | Run adapter-driven bots and analyze balance |
| `analyze` | Recompute analysis from simulation results |
| `report` | Build an HTML report from latest artifacts |
| `critique` | Generate a brief for a human or agent reviewer |
| `all` | Run probe, shots, simulation, analysis and report |

`all` captures scenarios through `shots` and enforces their verdict along with
probe and balance checks.
Exit codes are `0` for success, `1` for execution/configuration errors, and `2`
for failed checks (`probe` requires `--strict` to enforce its verdict).

Artifacts live in `<game>/.forge/<command>-<timestamp>/` with `latest-*` symlinks.
Ignore generated artifacts in your game's version control.

## Configuration and scenarios

The [configuration template](templates/forge.config.mjs) documents defaults.
Point `root` at the built/static game, set `entry`, and choose `viewport`.
`renderer: 'webgl'` enables the headless software WebGL path; `--headed` uses
the normal graphics path. Set `renderMode: 'on-demand'` for event-driven games.

[Scenario examples](../fixtures/tiny-game/forge/scenarios.mjs) show input,
assertions and screenshot steps. Use `realClick` or `click` to test physical
pointer reachability, and `hittable` to detect controls blocked by overlays.
Programmatic DOM clicks can bypass those overlays.

For simulations, implement the [adapter contract](adapters/ADAPTER.md).
Keep logic deterministic, with a fixed step and rendering separated from logic.
The bundled [tiny-game](../fixtures/tiny-game/) is the runnable reference.

## What is measured

Frame work is time spent inside game `requestAnimationFrame` callbacks on the
main thread. It excludes GPU work and main-thread work outside those callbacks.
Frame cadence, stalls and draw-call budgets provide additional signals.

Render checks combine drawing commands and pixel changes to catch a dead canvas.
They have limits: a quiet title screen and a stalled game may look identical.
A pass is evidence about configured checks, not a complete quality verdict.

Simulation reports include confidence intervals and flags such as `wall`,
`spike`, `timeout` and `bot-suspect`. Validate bot behavior before changing the
game's balance based on these results.

[Detailed notes and examples in Russian](README.ru.md) explain hit testing,
render checks, metrics, balance flags and known limits.

## Tests

```bash
npm run test:unit
npm run test:e2e
npm test
```

Browser tests require Chromium. Run trusted projects only: configs and adapters
are executable JavaScript, and the local server is not a production host.

[MIT license](../LICENSE).
