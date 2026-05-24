# mobile-recorder-skill

An agent skill that records polished, reproducible demo videos of iOS and Android apps. Drives [MobAI](https://mobai.run) to capture native pixels, then runs a Node + ffmpeg pipeline that adds tap ripples + finger overlay, frames the recording in a phone bezel + background, applies zoom / speed / trim from a sidecar `editor.json`, and exports to standard social formats.

> **Maintainer:** [MobAI](https://mobai.run) · [contact@mobai.run](mailto:contact@mobai.run) · [`@MobAI-App`](https://github.com/MobAI-App)
>
> **Platform:** macOS / Linux. iOS recording goes through MobAI's bridge; Android recording requires `adb`.

The skill teaches an agent to:

1. **Explore** the app via MobAI (UI tree, screenshots, OCR).
2. **Author** a `.mob` script - coordinate-only choreography, no predicates, no `if_exists`.
3. **Normalize state** outside the script (close app, dismiss popups, navigate to start).
4. **Dry-run** the `.mob` via `test_run` until it passes cleanly.
5. **Record** via `mobile_record_mjpeg.sh` (MobAI HTTP MJPEG, iOS Simulator + physical iOS) or `mobile_record_android.sh` (`adb screenrecord`).
6. **Edit** through `build_timeline → highlights → frame → zoom → speedups → export`.
7. **Ship** an mp4 with tap highlights, captions, variable speed, and upload copy.

Golden rule: `explore → script → dry-run → record → edit → export`. Never observe-then-decide mid-recording.

## Install

Paste this into Claude Code, Codex, Cursor, or any agent that can read a public repo and run shell commands:

> Set up `https://github.com/MobAI-App/mobile-recorder-skill` for me.
> Read `install.md` and follow the steps to install the pipeline
> dependencies (ffmpeg, jq, node), confirm MobAI is running, and
> register the skill with my agent runtime.

The flow checks `ffmpeg` / `node` / `jq`, walks you through MobAI install + simulator/device setup, copies `skills/mobile-recorder/` into your agent's skills directory, and runs a 2-second recording smoke test. Manual recipe in [`install.md`](./install.md).

## Use

Ask your agent for a recording:

- "Record a 30-second demo of MyApp on the iPhone 16 Pro simulator."
- "Make a vertical demo of the onboarding flow on Android."
- "Cut a bug repro of the login crash on iPhone."

The skill triggers automatically and produces:

```
demo.mob              reproducible choreography
editor.json           post-production directives (zoom / speed / trim)
demo.raw.mp4          native recording + .start_ts / .warmup_ms sidecars
demo.vertical.mp4     final 1080x1920 export + .captions.json sidecar
copy.md               upload copy
```

See [`skills/mobile-recorder/references/editing.md`](./skills/mobile-recorder/references/editing.md) for the editing stage chain and intermediate mp4s.

## Authorization

The skill drives a real device or simulator. It taps, swipes, types, and launches apps in the named target only; it asks before touching anything else. Recording captures whatever's on the device screen, so close any private windows before starting.

## Out of scope

Desktop / web demos (use the sibling [`desktop-recorder-skill`](https://github.com/MobAI-App/desktop-recorder-skill)), direct upload to YouTube/TikTok/X, AI voiceover/music, GUI video editing.

## License

[MIT](./LICENSE) - Copyright (c) 2026 [MobAI](https://mobai.run).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for dev setup and PR conventions. Reach out at [contact@mobai.run](mailto:contact@mobai.run) for anything that doesn't fit the issue tracker.
