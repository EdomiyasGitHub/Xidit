// Filter a frequency list produced by Snowball's
// scripts/wikipedia-dump-to-freq ("count<TAB>word" per line) down to
// plausible Somali words, before turning it into voc.txt.
//
// Rules (each rejection is written out with its reason, for manual review):
//   - letters a-z and the apostrophe only (Somali Latin orthography);
//   - no p, v or z: these letters are not used in Somali spelling, so words
//     containing them are almost always foreign names or loanwords;
//   - apostrophe only between letters, at most once (da'ay, ka'a);
//   - no letter repeated three times in a row (markup and typos);
//   - one-letter words only for the real ones: u, i, a.
// Like the Sesotho list in snowball-data, the result still needs a manual
// read-through (English words, names), ideally by the Somali reviewer.
//
// Usage:
//   node tools/filter-somali-freq.mjs so.freq --out so.filtered.freq --rejected so.rejected.tsv

import fs from "node:fs";
import { writeText, args } from "./lib.mjs";

const opt = args();
const input = opt._[0];
if (!input) {
  console.error("Usage: node tools/filter-somali-freq.mjs INPUT.freq --out OUTPUT.freq [--rejected REJECTED.tsv]");
  process.exit(1);
}
const OUT = opt.out ?? input.replace(/(\.freq)?$/, ".filtered.freq");
const REJ = opt.rejected ?? input.replace(/(\.freq)?$/, ".rejected.tsv");
const ONE_LETTER = new Set(["u", "i", "a"]);

function reason(w) {
  if (!/^[a-z']+$/.test(w)) return "characters outside a-z and apostrophe";
  if (/[pvz]/.test(w)) return "contains p, v or z (not used in Somali spelling)";
  if (/^'|'$/.test(w) || (w.match(/'/g) || []).length > 1) return "apostrophe at an edge or repeated";
  if (/(.)\1\1/.test(w)) return "same letter three times in a row";
  if (w.length === 1 && !ONE_LETTER.has(w)) return "single letter";
  return null;
}

const merged = new Map();
for (const line of fs.readFileSync(input, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const [count, raw] = line.split("\t");
  const w = (raw || "").normalize("NFC").toLowerCase().replace(/\u2019/g, "'");
  if (!w) continue;
  merged.set(w, (merged.get(w) || 0) + Number(count));
}

const kept = [];
const rejected = [];
for (const [w, n] of merged) {
  const r = reason(w);
  if (r) rejected.push([n, w, r]);
  else kept.push([n, w]);
}
kept.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
rejected.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
writeText(OUT, kept.map(([n, w]) => `${n}\t${w}`).join("\n") + "\n");
writeText(REJ, "count\tword\treason\n" + rejected.map((r) => r.join("\t")).join("\n") + "\n");
console.log(`Kept ${kept.length} words -> ${OUT}`);
console.log(`Rejected ${rejected.length} words -> ${REJ} (read through it: some may be real Somali words)`);
