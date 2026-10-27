// Build data/review-set.json: the items a Somali speaker reviews in the
// app's Review tab.
//
// Two kinds of item:
//   groups       Word groups the SNOWBALL stemmer merges (forms sharing one
//                stem). The reviewer marks forms that don't belong.
//                Selection: the most frequent groups ("top") plus a
//                deterministic pseudo-random sample of the rest ("random").
//                The random part gives an unbiased estimate of overall
//                accuracy; the top part covers what matters most in search.
//   comparisons  Words that Xidid and Snowball group differently. The
//                reviewer says which grouping is better, without being told
//                which stemmer made which (sides A/B are shuffled).
//
// Usage:
//   node tools/build-review-set.mjs                       # from data/corpus.json
//   node tools/build-review-set.mjs --freq so.freq        # from a Wikipedia frequency list
//   options: --top 60 --random 40 --comparisons 40 --min-count 2 --out data/review-set.json
//
// Example sentences always come from data/corpus.json; words that never
// occur there simply have no example.

import { readJson, writeText, corpusFrequencies, readFreqFile, hash, args, tokenize, normalize, xididMapper, snowballMapper } from "./lib.mjs";

const opt = args();
const TOP = Number(opt.top ?? 60);
const RANDOM = Number(opt.random ?? 40);
const COMPARISONS = Number(opt.comparisons ?? 40);
const MIN_COUNT = Number(opt["min-count"] ?? (opt.freq ? 5 : 1));
const OUT = opt.out ?? "data/review-set.json";
const MAX_FORMS = 15;
// Calibration items done together in session 1 (chosen to include clean
// and mixed groups). Skipped if absent from the vocabulary.
const PRACTICE_STEMS = ["saacad", "xaalad", "dugsi", "kar", "mar"];

const docs = readJson("data/corpus.json");
const freqAll = opt.freq ? readFreqFile(opt.freq) : corpusFrequencies(docs);
const freq = new Map([...freqAll].filter(([, n]) => n >= MIN_COUNT));
const source = opt.freq ? `frequency file ${opt.freq} (min count ${MIN_COUNT})` : "data/corpus.json";

const xid = xididMapper();
const sb = snowballMapper();

// --- example sentences from the corpus: first occurrence of each form ---
const examples = new Map();
for (const d of docs) {
  const toks = [...d.text.matchAll(/[\p{L}']+/gu)];
  toks.forEach((m, i) => {
    const f = normalize(m[0]);
    if (!f || examples.has(f)) return;
    const from = Math.max(0, i - 6);
    const to = Math.min(toks.length, i + 7);
    const start = toks[from].index;
    const end = toks[to - 1].index + toks[to - 1][0].length;
    examples.set(f, {
      docId: d.id,
      text: (from > 0 ? "\u2026" : "") + d.text.slice(start, end) + (to < toks.length ? "\u2026" : ""),
      word: m[0],
    });
  });
}

// --- groups under each stemmer ---
function groupsBy(mapTerm) {
  const byStem = new Map();
  for (const [form, n] of freq) {
    const s = mapTerm(form);
    if (!s) continue;
    if (!byStem.has(s)) byStem.set(s, []);
    byStem.get(s).push({ form, count: n });
  }
  for (const list of byStem.values()) list.sort((a, b) => b.count - a.count || a.form.localeCompare(b.form));
  return byStem;
}
const sbGroups = groupsBy(sb);
const xGroups = groupsBy(xid);

const withExample = (f) => ({ ...f, example: examples.get(f.form) || null });
const total = (list) => list.reduce((a, f) => a + f.count, 0);

const merged = [...sbGroups.entries()].filter(([, list]) => list.length >= 2);
const practiceStems = PRACTICE_STEMS.filter((s) => sbGroups.has(s) && sbGroups.get(s).length >= 2);
const pool = merged.filter(([s]) => !practiceStems.includes(s));
pool.sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]));
const top = pool.slice(0, TOP);
const rest = pool.slice(TOP).sort((a, b) => hash(a[0]) - hash(b[0]) || a[0].localeCompare(b[0]));
const random = rest.slice(0, RANDOM);

const makeGroup = ([stem, list], sample, i) => ({
  id: `${sample[0]}${String(i + 1).padStart(3, "0")}`,
  sample, // "practice" | "top" | "random"
  stem, // not shown to the reviewer: stems need not be words and would bias them
  totalForms: list.length,
  forms: list.slice(0, MAX_FORMS).map(withExample),
});

const groups = [
  ...practiceStems.map((s, i) => makeGroup([s, sbGroups.get(s)], "practice", i)),
  ...top.map((g, i) => makeGroup(g, "top", i)),
  ...random.map((g, i) => makeGroup(g, "random", i)),
];

// --- comparisons: words whose Xidid group and Snowball group differ ---
const comparisons = [];
const seen = new Set();
const byFreq = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
for (const [word] of byFreq) {
  if (comparisons.length >= COMPARISONS) break;
  const xs = xGroups.get(xid(word)) || [];
  const ss = sbGroups.get(sb(word)) || [];
  const xSet = xs.map((f) => f.form).sort();
  const sSet = ss.map((f) => f.form).sort();
  if (xSet.join(" ") === sSet.join(" ")) continue;
  if (xSet.length < 2 && sSet.length < 2) continue;
  const key = [xSet.join(" "), sSet.join(" ")].sort().join(" | ");
  if (seen.has(key)) continue;
  seen.add(key);
  const xididIsA = hash(word) % 2 === 0; // shuffle sides; analysis un-shuffles
  const a = xididIsA ? xs : ss;
  const b = xididIsA ? ss : xs;
  comparisons.push({
    id: `c${String(comparisons.length + 1).padStart(3, "0")}`,
    word,
    example: examples.get(word) || null,
    a: a.slice(0, MAX_FORMS).map((f) => ({ form: f.form, count: f.count })),
    b: b.slice(0, MAX_FORMS).map((f) => ({ form: f.form, count: f.count })),
    aTotal: a.length,
    bTotal: b.length,
    sides: { a: xididIsA ? "xidid" : "snowball", b: xididIsA ? "snowball" : "xidid" },
  });
}

const body = {
  version: 1,
  source,
  vocabularySize: freq.size,
  snowballMergedGroups: merged.length,
  instructions:
    "Groups: mark every word form that is NOT a form of the same basic word as the others. Comparisons: choose which group of words belongs with the word shown.",
  groups,
  comparisons,
};
body.setId = `rs-${hash(JSON.stringify(body)).toString(36)}`;
writeText(OUT, JSON.stringify(body, null, 1) + "\n");

const n = (s) => groups.filter((g) => g.sample === s).length;
console.log(`Wrote ${OUT} (set ${body.setId})`);
console.log(`  vocabulary: ${freq.size} forms from ${source}; ${merged.length} Snowball groups with 2+ forms`);
console.log(`  groups: ${n("practice")} practice, ${n("top")} top, ${n("random")} random; comparisons: ${comparisons.length}`);
console.log(`  forms to look at: ${groups.reduce((a, g) => a + g.forms.length, 0)} in groups`);
