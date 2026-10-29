# gamedev-forge

**English** | [Русский](README.ru.md)

Local tools for testing web games and building game assets with Blender.
Made for short feedback loops: run the game, inspect screenshots, measure it,
change one thing, and run it again.

- **[game-forge](game-forge/README.md)** runs browser scenarios, captures screenshots,
  checks performance budgets and simulates game balance through an adapter.
- **[blender-kit](blender-kit/README.md)** renders model previews and bakes 3D models
  into transparent sprite atlases with Phaser-compatible JSON.
- **[Optional agent helpers](claude/)** provide Claude Code skills and review prompts.
  The command-line tools work independently of any AI service or API key.

Early-stage developer tooling. Getting-started documentation is available in
English and Russian. Code comments, CLI diagnostics and agent helpers are in
English; historical design notes and journals remain in Russian.

## Try game-forge

Use **Node.js 22+**, npm and macOS or Linux. CI runs on Ubuntu with Node.js 22.
Windows is not currently validated; use WSL for the shell helpers.

```bash
git clone https://github.com/pawellazarew/gamedev-forge.git
cd gamedev-forge/game-forge
npm ci
npx playwright-core install chromium
node bin/forge.mjs doctor
node bin/forge.mjs play ../fixtures/tiny-game
node bin/forge.mjs all ../fixtures/tiny-game --runs 10
```

Linux machines may need browser system libraries:
`npx playwright-core install --with-deps chromium`.

Results are saved under `fixtures/tiny-game/.forge/`, including `latest-*`
links to the most recent runs. `report` prints the generated HTML report path.
The bundled fixture needs no game engine or build step.

## Connect your game

From `game-forge/`:

```bash
node bin/forge.mjs init /absolute/path/to/game
node bin/forge.mjs probe /absolute/path/to/game --seconds 8 --strict
node bin/forge.mjs shots /absolute/path/to/game
node bin/forge.mjs play /absolute/path/to/game
```

Edit the generated `forge.config.mjs` to point at your game's static build
(`root` and `entry`). Configure browser scenarios in `forge/scenarios.mjs`.
For WebGL, set `renderer: 'webgl'`; for event-driven rendering, set
`renderMode: 'on-demand'`.

`probe` does not require a simulation adapter. For balance simulation (`sim`, also used by `all` when configured), implement the [adapter contract](game-forge/adapters/ADAPTER.md).
See [tiny-game](fixtures/tiny-game/) for a self-contained example and
[worked integrations](docs/examples/) for larger ones.

## Try blender-kit

Install **Blender 5.x** separately. On Linux, put `blender` on `PATH`; on macOS,
the wrapper also detects `/Applications/Blender.app`. Override either with
`BLENDER_APP=/absolute/path/to/blender`.

```bash
cd blender-kit
./blend.sh demo_robot.py -- --out /tmp/robot.blend
./blend.sh render_preview.py --blend /tmp/robot.blend -- --out /tmp/preview.png
./blend.sh bake_sprites.py --blend /tmp/robot.blend -- \
  --out /tmp/robot-sprites --anim walk --dirs 8 --frames 1-24 --step 3 --size 96
```

No BlenderMCP connection is needed for these commands.
[Blender options and limitations →](blender-kit/README.md)

## Optional Claude Code setup

```bash
./install.sh /absolute/path/to/project
```

This copies agents and skills into the project's `.claude/` directory;
existing files with the same names are overwritten. Review the prompts before
installing. The installer prints the expected `tools/` symlinks.
Review prompts that call other model CLIs require those tools separately.

## What the results mean

- Frame work measures JavaScript work inside animation callbacks, **not GPU time**.
  Use `--headed` for hardware-backed WebGL and profile on target devices.
- A passing probe means no configured check failed. It does not prove visual
  quality, mobile performance, accessibility or that the game is fun.
- Simulations measure the supplied bots. A balance wall may be a bot defect.
- Screenshot capture does not perform visual review automatically. Open the PNGs
  yourself or supply them to a reviewer.
- Only run trusted games, configs, adapters and Blender scripts. These execute
  code locally. The built-in server is for local testing, not public hosting.

[Detailed measurement notes →](game-forge/README.md#what-is-measured)

## Development

```bash
cd game-forge
npm ci
npm run test:unit
npm run test:e2e  # requires Chromium
```

CI also checks positive and negative render fixtures, real pointer hit testing,
simulation output and script syntax. Blender rendering is not covered by CI.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## License and credits

[MIT](LICENSE). Adapted Blender hard-surface material retains its original
copyright and MIT license; see [third-party notices](THIRD_PARTY_NOTICES.md).

Inspired by [The Long Silence](https://github.com/achimala/TheLongSilence)
and Anton Chuev's talk on the difficulties of AI-assisted game development.
