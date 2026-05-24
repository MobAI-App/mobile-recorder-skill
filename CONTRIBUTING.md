# Contributing

`mobile-recorder-skill` is the agent skill: Markdown instructions, JSON
examples, and a Node + ffmpeg pipeline that turns a MobAI `test_run`
into a polished demo video. PRs welcome.

The recording itself is driven by MobAI (separate desktop app +
bridge). This repo carries no native binaries.

Maintainer: [MobAI](https://mobai.run) - contact@mobai.run

## Development setup

No build step. Edit Markdown / JS / shell in place. The skill loads
whatever's in `skills/mobile-recorder/SKILL.md`, references in
`references/`, scripts in `scripts/`. Test locally by pointing your
agent at the folder (or copy it into your agent's skills directory).

If you change a `scripts/*.js`, run it against a real recording to
confirm it exits cleanly and produces the expected files + sidecars.
The pipeline order is documented in
[`skills/mobile-recorder/references/editing.md`](./skills/mobile-recorder/references/editing.md).

## PR conventions

- Keep changes focused: one fix or one feature per PR.
- Update `skills/mobile-recorder/references/mobile.md` if the change
  relies on a new MobAI feature or `.mob` syntax.
- Update `skills/mobile-recorder/SKILL.md` when you change the pipeline
  ordering, recorder workflow, or add new agent-facing recipes.
- Update `skills/mobile-recorder/references/editing.md` for changes
  to the editing chain, defaults, or new ffmpeg primitives.
- Don't commit demo recordings (`.mp4`, `.mov`) outside
  `skills/mobile-recorder/assets/examples/`.

## Filing bugs

Useful info for repro:
- macOS / Linux version
- `node --version`, `ffmpeg -version` (first line)
- MobAI app version + bridge state (`mobai doctor` if available)
- iOS Simulator / physical device / Android, and iOS or Android version
- The exact pipeline command and its full stderr/stdout
- For visual issues: `ffprobe -show_streams <output.mp4>` plus the
  source `.mob` + `editor.json` + `test_run.json` if you can share
  them

## Code of conduct

Be kind. Anything else, send to contact@mobai.run.
