# Installation guide

> This file is meant to be read by an AI agent and executed step-by-step.
> If you're a human reading it, jump to the [Manual recipe](#manual-recipe-no-agent) section at the bottom.

You're installing three things:

1. **MobAI** - the desktop app + bridge that drives the iOS Simulator, physical iOS devices, and Android. The skill talks to it via the local MJPEG HTTP stream (for recording) and via the `test_run` MCP tool (for choreography replay).
2. **The pipeline dependencies** - `ffmpeg`, `ffprobe`, `node`, `jq`.
3. **The skill** - `skills/mobile-recorder/` from this repo, copied into the user's agent skills directory.

Total time: ~5 minutes if Homebrew and MobAI are already installed.

---

## Pre-flight checks

Run these and stop if anything fails - don't try to "fix" missing prerequisites silently.

```bash
node --version                   # expect >= 16
ffmpeg -version | head -1        # expect any recent build with libass
ffprobe -version | head -1       # ships with ffmpeg
jq --version                     # any
ffmpeg -filters 2>/dev/null | grep -q subtitles || echo "MISSING libass"
```

If any line errors out, install via Homebrew (`brew install node ffmpeg jq`) or your package manager before continuing.

---

## Step 1 - Install MobAI

MobAI is a separate macOS app. The skill talks to it but does not bundle it.

Install from [mobai.run](https://mobai.run) (download + drag-to-Applications, or whatever flow the site documents at install time). Then start the MobAI app and confirm the bridge is running.

The skill needs MobAI's MCP server reachable in your agent runtime. For Claude Code that means an entry in `~/.config/claude/claude_desktop_config.json` (or your equivalent MCP config). Confirm the agent can call `mcp__mobai__list_devices` before proceeding.

---

## Step 2 - Bring up a target device

Pick at least one:

```bash
# iOS Simulator
xcrun simctl list devices booted                  # any booted device?
# If empty, boot one:
xcrun simctl boot "iPhone 16 Pro"

# Android emulator or physical
adb devices                                       # device should be listed
```

For physical iOS devices, connect via cable and accept the trust prompt; MobAI's bridge will pick it up.

---

## Step 3 - Register the skill

The skill is the `skills/mobile-recorder/` folder from this repo. Where it goes depends on the agent runtime:

| Runtime | Skills directory |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Codex CLI | `~/.codex/skills/` (if you use a skill manager) |
| Cursor / Continue / generic | Wherever your agent looks; or paste `SKILL.md` content into the system prompt |

**Detect, then install.** Try the most likely path first:

```bash
SKILL_DIR=""
for candidate in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
    if [[ -d "$candidate" ]]; then
        SKILL_DIR="$candidate"
        break
    fi
done

if [[ -z "$SKILL_DIR" ]]; then
    echo "No known skills directory found."
    echo "If you're on Claude Code, create ~/.claude/skills/ and re-run."
    echo "If you're using a different runtime, copy skills/mobile-recorder/SKILL.md into your agent's system prompt manually."
    exit 1
fi

# Clone the repo if you don't have it locally:
TMP="${TMP:-/tmp/mrs}"
[[ -d "$TMP/.git" ]] || git clone https://github.com/MobAI-App/mobile-recorder-skill.git "$TMP"

# Copy the skill folder into place
DEST="$SKILL_DIR/mobile-recorder"
rm -rf "$DEST"
cp -R "$TMP/skills/mobile-recorder" "$DEST"
echo "Installed skill at: $DEST"
```

The skill folder contains:

```
SKILL.md             ← main agent instructions (auto-loaded by trigger phrases)
references/          ← mobile.md, timeline.md, editor.md, editing.md
scripts/             ← build_timeline.js, add_highlights.js, add_frame.js,
                       add_zoom.js, add_speedups.js, export_video.js,
                       burn_captions.js, generate_copy.js,
                       mobile_record_{mjpeg,ios_sim,android,stop}.sh,
                       lib/editor.js (shared loader)
assets/              ← examples + templates
```

---

## Step 4 - Verify end-to-end

```bash
# Skill installed?
ls "$SKILL_DIR/mobile-recorder/SKILL.md"

# A booted simulator (or connected device) the agent can drive?
xcrun simctl list devices booted | grep -q Booted || echo "no booted iOS Simulator"
adb devices 2>/dev/null | grep -E '\sdevice$' >/dev/null || echo "no adb device (skip if iOS-only)"

# MobAI bridge reachable? (required for recording)
curl -fsS --max-time 1 http://127.0.0.1:8686/devices > /dev/null && echo "MobAI bridge OK" || echo "MobAI bridge unreachable - is the app running?"
```

If the bridge responds, install is complete. The user can now ask the agent things like:

> "Record a 30-second demo of MyApp on the iPhone 16 Pro simulator."
> "Make a vertical demo of the onboarding flow on Android."

The skill will trigger automatically.

---

## Manual recipe (no agent)

```bash
# 1. Pipeline deps
brew install node ffmpeg jq

# 2. Install MobAI from https://mobai.run, start it, confirm the bridge.

# 3. Boot a target
xcrun simctl boot "iPhone 16 Pro"   # or: plug in an Android device with USB debugging

# 4. Install the skill
git clone https://github.com/MobAI-App/mobile-recorder-skill.git /tmp/mrs
mkdir -p ~/.claude/skills
cp -R /tmp/mrs/skills/mobile-recorder ~/.claude/skills/mobile-recorder
```

---

## Uninstall

```bash
# Remove the skill
rm -rf ~/.claude/skills/mobile-recorder     # adjust path for your runtime
```

Uninstall MobAI from `/Applications` if you no longer need device automation.
