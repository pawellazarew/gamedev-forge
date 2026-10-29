---
name: game-forge
description: "Autonomous web-game development pipeline: launch games, run bots, capture and inspect screenshots, measure performance, analyze hundreds of balance simulations and critique the result. Use to run or inspect a game, check balance, play on the user's behalf, iterate autonomously, or verify a game before platform submission without manual playtesting on every iteration. Tool: tools/game-forge."
---

# Game Forge

Close the feedback loop: game → measurements and screenshots → critique → changes
→ another measurement. Without this loop, an agent edits the game without seeing it.

Code: `tools/game-forge/`. Run artifacts: `<game>/.forge/`.

## Three levels of game access

| Level | Game requirements | Result |
|---|---|---|
| 1. Observation | none | `probe`: frame work, errors, bundle size, rendering activity |
| 2. Scenarios | none (or an adapter) | `shots`, `play`: screenshots of key screens and assertions |
| 3. Simulation | a `__FORGE__` adapter | `sim`, `analyze`: hundreds of runs and a difficulty curve |

Start at level 1: it works immediately with any web game.

## Commands

```bash
cd tools/game-forge && npm install     # once
node bin/forge.mjs doctor              # check the environment

node bin/forge.mjs init  <game>        # generate forge.config.mjs and templates
node bin/forge.mjs probe <game>        # technical checks: frame work, errors, size
node bin/forge.mjs shots <game>        # capture scenario screenshots
node bin/forge.mjs play  <game>        # scenarios and assertions; fail on failed checks
node bin/forge.mjs sim   <game> --runs 40 --max-ticks 150000
node bin/forge.mjs analyze <game>      # recompute balance from the latest simulation
node bin/forge.mjs report  <game>      # combine results in HTML
node bin/forge.mjs critique <game>     # prepare a critic brief
node bin/forge.mjs all <game>          # probe + shots + sim + analyze + report
```

## Essential: actually inspect the screenshots

After `shots`, open every PNG with **Read** so you can see the image.
A screenshot is not reviewed until you have opened it. Screenshot paths and
notes on what to inspect are in `.forge/latest-shots/shots.json`.

## Connect a new game

1. Run `node bin/forge.mjs init games-business/my-game`.
2. Set `root`/`entry`/`viewport` in `forge.config.mjs`; use `renderer: 'webgl'` for 3D.
3. Write at least `first-run` (the first 30 seconds) and `phone` scenarios.
   Press DOM buttons with `realClick: '#btn'` instead of `eval: "…click()"` or
   adapter functions. Programmatic DOM clicks pass through overlays and can make
   scenarios pass when the game's controls are unusable. Add primary buttons and
   panels to the config's `hittable`: play checks them at scenario completion and
   in three viewports.
4. For simulation, implement `start / tick / state / act / bots` using
   `tools/game-forge/adapters/ADAPTER.md`. Game requirements: a fixed logic step,
   rendering separated from logic, and no `Date.now()` in game logic.

A complete integration with a real game is in `games-business/brick-breaker/forge/`.

## Autonomous loop

The loop can run on its own (`/loop`, ralph-loop or an ordinary session), but
it needs boundaries to avoid endless polishing.

```text
1. forge all <game>
2. Read flags and open screenshots
3. Ask critics: game-art-critic (screenshots), game-balance-critic (numbers)
4. Select ONE finding with the greatest player impact
5. Fix it, rerun forge, compare the metric before and after
6. Add a line to <game>/.forge/JOURNAL.md: what changed and the result
7. Stop if two consecutive iterations improve no metric
```

### Rules that keep the loop useful

- **Set a stopping condition.** At most N iterations, or until no high-severity
  flags remain. “Until it looks beautiful” has no achievable boundary.
- **One change per iteration.** Otherwise the cause of improvement is unclear.
- **Keep the harness separate.** The agent fixing a game must not edit
  `tools/game-forge` or its scenarios to make checks pass. Change a measurement
  in a separate, explicit step explaining why the previous measurement was wrong.
- **Validate data before drawing conclusions.** `bot-suspect` or timeouts above
  20% make balance data unreliable.
- **`wall` marks where a bot stopped, not necessarily a player.** Before calling
  it a game defect, run an ablation: a policy tailored to that exact stage.
  If that also fails, the wall is real. In REBOOT, the “Laboratory wall” was a
  bot that did not craft copper and silicon; the full chain cleared the stage
  in 100% of runs.
- **Numbers need visual inspection.** 60 fps and passing flags can coexist with
  an unreadable screen. Inspect the screenshots.

## Second opinion (Codex)

Our critics use the same model as the developer, so they are reviewing their
own work. Codex provides an independent view and can inspect screenshots:

```bash
codex exec --cd <game> -i .forge/latest-shots/shots/first-run-03-midgame.png - <<'PROMPT'
You are an adversarial visual critic. Identify at most four defects, ordered by
player impact: what is wrong → why it hurts → a concrete fix. Skip praise.
PROMPT
```

For balance, use the same approach with `analysis.json` in the prompt and ask
Codex to “try to prove this conclusion wrong.” The `codex-assistant` agent
contains invocation details. Disagreement between models is more informative
than agreement: their dispute often points to the actual problem.

## What the pipeline cannot measure

Fun. Bots do not get bored or frustrated; simulations measure completion rates,
not enjoyment. The pipeline narrows attention to three places a person should
try manually, but it does not replace live playtesting.

## Related tools

- Screenshots → `game-art-critic`; numbers → `game-balance-critic`
- Churn and onboarding → `casual-game-ux-analyst` agent
- Game feel and responsiveness → `game-feel-toolkit` skill
- Procedural audio → `web-audio-sound-designer` skill
- Blender 3D assets and sprites → `blender-hardsurface`, `sprite-baking` skills
