// Build dist/xidid.html: the whole app as ONE self-contained HTML file,
// for hosts that serve a single page (such as a Claude artifact).
//
// What it does:
//   - bundles js/app.js and everything it imports into one script (esbuild,
//     fetched on demand by npx; nothing to install),
//   - inlines css/style.css,
//   - inlines the data/*.json files the app loads (read via
//     window.__XIDID_DATA__, see loadJson in js/app.js),
//   - embeds the promo film and its poster as data URLs (MP4 only, to keep
//     the file small; every current browser plays it).
//
// The normal multi-file site (index.html + js/ + data/) is unchanged and
// is still what you run locally or put on GitHub Pages.
//
// Usage (from the project root, needs Node.js 18+ and internet for npx):
//   node tools/build-single-file.mjs            -> dist/xidid.html

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "./lib.mjs";

const ESBUILD = "esbuild@0.24.0"; // pinned
const DATA_FILES = [
  "data/protected_words.json",
  "data/stem_overrides.json",
  "data/somali_words.json",
  "data/corpus.json",
  "data/qrels.json",
  "data/review-set.json",
];
const OUT = path.join(ROOT, "dist", "xidid.html");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

// Text placed inside <script> must not contain "</script" (or "<!--").
const scriptSafe = (s) => s.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");

console.log(`Bundling js/app.js with ${ESBUILD} ...`);
const bundle = execFileSync(
  "npx",
  ["--yes", ESBUILD, "js/app.js", "--bundle", "--format=iife", "--target=es2022", "--minify-syntax", "--legal-comments=inline"],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] }
);

const data = {};
for (const f of DATA_FILES) data[f] = JSON.parse(read(f).toString("utf8"));
// JSON with "<" escaped is valid JS and can't close the script element.
const dataJs = `window.__XIDID_DATA__ = ${JSON.stringify(data).replace(/</g, "\\u003c")};`;

const css = read("css/style.css").toString("utf8");
const dataUrl = (rel, mime) => `data:${mime};base64,${read(rel).toString("base64")}`;

let html = read("index.html").toString("utf8");
const replaceOnce = (pattern, replacement, what) => {
  const before = html;
  html = html.replace(pattern, replacement);
  if (html === before) throw new Error(`build-single-file: couldn't find ${what} in index.html`);
};

// Viewport that also lets phones draw under translucent system bars.
replaceOnce(
  /<meta name="viewport"[^>]*>/,
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
  "the viewport meta tag"
);
replaceOnce(
  /<link rel="stylesheet" href="css\/style.css"\s*\/?>/,
  () =>
    `<style>\n${css}\n/* single-file build: keep content clear of phone system bars */\n:root { box-sizing: border-box; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }\nhtml { scroll-padding-top: env(safe-area-inset-top, 0px); }\n</style>`,
  "the stylesheet link"
);
replaceOnce(/ poster="assets\/xidid-promo-poster.jpg"/, () => ` poster="${dataUrl("assets/xidid-promo-poster.jpg", "image/jpeg")}"`, "the video poster");
replaceOnce(
  /<source src="assets\/xidid-promo.mp4" type="video\/mp4" \/>/,
  () => `<source src="${dataUrl("assets/xidid-promo.mp4", "video/mp4")}" type="video/mp4" />`,
  "the MP4 source"
);
replaceOnce(/\s*<source src="assets\/xidid-promo.webm" type="video\/webm" \/>/, "", "the WebM source");
replaceOnce(
  /<script type="module" src="js\/app.js"><\/script>/,
  () => `<script>\n${scriptSafe(dataJs)}\n</script>\n<script>\n${scriptSafe(bundle)}\n</script>`,
  "the app script tag"
);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
console.log(`Wrote ${path.relative(ROOT, OUT)} (${mb} MB)`);
if (fs.statSync(OUT).size > 16 * 1024 * 1024) console.warn("Warning: over 16 MB, too large to publish as a Claude artifact.");
