# Contributing

Open an issue with a reproducible example for bugs or proposed changes.
For a fix, create a branch and submit a pull request against `main`.

Use Node.js 22+, run `npm ci` in `game-forge/`, and install Chromium with
`npx playwright-core install chromium`. Run `npm test` there before submitting.
For shell changes run `bash -n` on each changed script; for Blender changes,
also test in Blender 5.x and describe the version, OS and rendered output.

When changing a quality gate, include a fixture that should fail and a healthy
fixture that should pass. Do not weaken a gate just to make a game pass.
Document changes to commands, configuration and output formats in the README.

Keep generated `.forge/` outputs, `.blend` files and credentials out of commits.
Contributions are provided under this repository's MIT license; preserve
third-party notices when adapting external material.
