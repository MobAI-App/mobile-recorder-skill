#!/usr/bin/env node
/**
 * Generate upload copy (title / short post / Shorts title / thumbnail text)
 * from a demo timeline + the original prompt.
 *
 * Usage:
 *   node generate_copy.js <timeline.json> <prompt.txt> <copy.md> [--template path]
 *
 * The script reads assets/templates/copy-template.md (override via --template)
 * and substitutes the following placeholders:
 *   {{title}}          strongest caption (longest) or first intent
 *   {{short_post}}     2–3 sentences built from intents + first caption
 *   {{shorts_title}}   first caption, truncated to 40 chars
 *   {{thumbnail_text}} first caption, truncated to 5 words
 *   {{hashtags}}       blank by default; edit the output before posting
 *
 * Strategy is deterministic — no LLM call here. The agent invoking this skill
 * can rewrite the output if it wants more polish.
 */

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
if (argv.length < 3) {
  console.error("usage: node generate_copy.js <timeline.json> <prompt.txt> <copy.md> [--template path]");
  process.exit(2);
}

const [TIMELINE, PROMPT, OUT] = argv.slice(0, 3);

function readFlag(name, def) {
  const i = argv.indexOf(name);
  // Treat a following `--something` as the next flag, not this flag's value.
  // Without this guard, `--template --debug` would parse `--debug` as the
  // template path.
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return def;
}

const DEFAULT_TEMPLATE = path.join(__dirname, "..", "assets", "templates", "copy-template.md");
const TEMPLATE = readFlag("--template", DEFAULT_TEMPLATE);

if (!fs.existsSync(TEMPLATE)) {
  console.error(`template not found: ${TEMPLATE}`);
  process.exit(3);
}

const events = JSON.parse(fs.readFileSync(TIMELINE, "utf8"));
const prompt = fs.existsSync(PROMPT) ? fs.readFileSync(PROMPT, "utf8").trim() : "";
const template = fs.readFileSync(TEMPLATE, "utf8");

const captions = events.map((e) => e.caption).filter(Boolean);
const intents  = events.map((e) => e.intent).filter(Boolean);

function truncWords(s, n) {
  return s.split(/\s+/).slice(0, n).join(" ");
}
function truncChars(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

const strongest = captions
  .slice()
  .sort((a, b) => b.length - a.length)[0];

const title         = strongest || intents[0] || "Demo";
const firstCaption  = captions[0] || intents[0] || "Watch the demo";
const shortsTitle   = truncChars(firstCaption, 40);
const thumbnailText = truncWords(firstCaption, 5);

const flowSentence = intents.length > 0
  ? `Quick walk-through: ${intents.slice(0, 4).join(", ")}.`
  : `Quick demo of the flow.`;

const shortPost = [
  flowSentence,
  firstCaption.endsWith(".") ? firstCaption : firstCaption + ".",
  prompt ? `Context: ${truncWords(prompt, 25)}.` : "",
].filter(Boolean).join("\n\n");

const substitutions = {
  title,
  short_post: shortPost,
  shorts_title: shortsTitle,
  thumbnail_text: thumbnailText,
  hashtags: "",
};

const out = template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
  Object.prototype.hasOwnProperty.call(substitutions, key) ? substitutions[key] : match
);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);

console.log(`Copy → ${OUT}`);
