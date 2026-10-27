// Shared helpers for the command-line tools. They reuse the web app's own
// modules, so the tools stem words exactly as the app does.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "../js/textUtils.js";
import { tokenize, makeStemMapper, makeSnowballMapper } from "../js/ir.js";
import SomaliSnowballStemmer from "../js/snowball/somali-stemmer.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, rel), "utf8"));
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), text);
}

/** Xidid's stemmer configured exactly like the app's defaults. */
export function xididMapper() {
  const lexicon = new Set(readJson("data/somali_words.json").map(normalize).filter(Boolean));
  const overrides = new Map(
    Object.entries(readJson("data/stem_overrides.json")).map(([k, v]) => [normalize(k), normalize(v)])
  );
  const prot = new Set(readJson("data/protected_words.json").map(normalize).filter(Boolean));
  return makeStemMapper({ protected: prot, overrides, lexicon });
}

export function snowballMapper() {
  return makeSnowballMapper(new SomaliSnowballStemmer());
}

/** Word -> count over the corpus (normalised forms). */
export function corpusFrequencies(docs) {
  const freq = new Map();
  for (const d of docs) {
    for (const t of tokenize(d.text)) {
      const f = normalize(t);
      if (f) freq.set(f, (freq.get(f) || 0) + 1);
    }
  }
  return freq;
}

/** Read a Snowball-style frequency file ("count<TAB>word" per line). */
export function readFreqFile(file) {
  const freq = new Map();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const [count, word] = line.split("\t");
    const w = normalize(word || "");
    if (w) freq.set(w, (freq.get(w) || 0) + Number(count));
  }
  return freq;
}

/** Stable 32-bit hash (FNV-1a) for deterministic sampling and side order. */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Simple argv parser: --key value and --flag. */
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

export { normalize, tokenize };
