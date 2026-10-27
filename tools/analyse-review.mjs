// Analyse a Somali speaker's review (the file downloaded from the Review
// tab) and write a Markdown report.
//
// Usage:
//   node tools/analyse-review.mjs review-results.json [more-results.json ...]
//   options: --set data/review-set.json --out reports/review-report.md
//
// With two or more result files it also reports agreement between
// reviewers (per form for groups, per item for comparisons).

import fs from "node:fs";
import { readJson, writeText, args } from "./lib.mjs";

const opt = args();
const files = opt._;
if (!files.length) {
  console.error("Usage: node tools/analyse-review.mjs review-results.json [more.json ...] [--set data/review-set.json] [--out reports/review-report.md]");
  process.exit(1);
}
const set = readJson(opt.set ?? "data/review-set.json");
const OUT = opt.out ?? "reports/review-report.md";
const results = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
for (const [i, r] of results.entries()) {
  if (r.setId !== set.setId) {
    console.warn(`Warning: ${files[i]} was made for review set ${r.setId}, but ${opt.set ?? "data/review-set.json"} is ${set.setId}. Items are matched by id; check they are the same set.`);
  }
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "\u2014");
const lines = [];
const out = (s = "") => lines.push(s);

// The ending a stemmer removed: what's left of the form after the stem.
const ending = (form, stem) => (form.startsWith(stem) ? form.slice(stem.length) || "(none)" : "(changed)");

for (const [ri, res] of results.entries()) {
  const who = res.reviewer?.name || `reviewer ${ri + 1}`;
  out(`# Review report: ${who}`);
  out();
  out(`Review set \`${set.setId}\` (${set.source}). Results file: \`${files[ri]}\`, last saved ${res.updated || "unknown"}.`);
  out();

  // --- groups ---
  const reviewed = set.groups.filter((g) => g.sample !== "practice" && res.groups?.[g.id]?.done);
  out(`## Snowball word groups`);
  out();
  out(`Reviewed ${reviewed.length} of ${set.groups.filter((g) => g.sample !== "practice").length} groups (practice items excluded).`);
  out();
  out(`| Sample | Groups | All forms belong | Forms checked | Forms that belong (precision) |`);
  out(`| --- | --- | --- | --- | --- |`);
  const endingStats = new Map(); // ending -> {total, wrong}
  const outlierRows = [];
  for (const sample of ["top", "random"]) {
    const gs = reviewed.filter((g) => g.sample === sample);
    let clean = 0, forms = 0, wrong = 0;
    for (const g of gs) {
      const r = res.groups[g.id];
      const outliers = new Set(r.outliers || []);
      if (outliers.size === 0) clean++;
      for (const f of g.forms) {
        forms++;
        const e = ending(f.form, g.stem);
        const st = endingStats.get(e) || { total: 0, wrong: 0 };
        st.total++;
        if (outliers.has(f.form)) {
          wrong++;
          st.wrong++;
          outlierRows.push({ form: f.form, group: g.forms.map((x) => x.form).slice(0, 5).join(", "), stem: g.stem, ending: e, unsure: !!r.unsure, note: r.note || "" });
        }
        endingStats.set(e, st);
      }
    }
    out(`| ${sample === "top" ? "Most frequent" : "Random sample"} | ${gs.length} | ${clean} (${pct(clean, gs.length)}) | ${forms} | ${forms - wrong} (${pct(forms - wrong, forms)}) |`);
  }
  out();
  out(`The random sample estimates accuracy across all ${set.snowballMergedGroups} merged groups in the vocabulary; the frequent groups show what matters most for search.`);
  out();

  out(`### Forms marked as not belonging`);
  out();
  if (!outlierRows.length) out(`None.`);
  else {
    out(`| Form | Group (first forms) | Stem | Ending removed | Unsure | Note |`);
    out(`| --- | --- | --- | --- | --- | --- |`);
    for (const r of outlierRows) out(`| ${r.form} | ${r.group} | ${r.stem} | -${r.ending} | ${r.unsure ? "yes" : ""} | ${r.note.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  }
  out();

  out(`### Endings most often involved in wrong merges`);
  out();
  out(`Candidates for rule changes: endings whose removal often produced a form marked as not belonging. Small counts are weak evidence; confirm with the reviewer in session 3.`);
  out();
  const risky = [...endingStats.entries()].filter(([, s]) => s.wrong > 0).sort((a, b) => b[1].wrong - a[1].wrong || b[1].wrong / b[1].total - a[1].wrong / a[1].total);
  if (!risky.length) out(`No ending was involved in a wrong merge.`);
  else {
    out(`| Ending removed | Wrong | Of forms with this ending | Error rate |`);
    out(`| --- | --- | --- | --- |`);
    for (const [e, s] of risky.slice(0, 20)) out(`| -${e} | ${s.wrong} | ${s.total} | ${pct(s.wrong, s.total)} |`);
  }
  out();

  // --- comparisons ---
  const comps = set.comparisons.filter((c) => res.comparisons?.[c.id]?.choice);
  const tally = { xidid: 0, snowball: 0, "both-good": 0, "both-bad": 0 };
  const compRows = [];
  for (const c of comps) {
    const r = res.comparisons[c.id];
    const winner = r.choice === "a" ? c.sides.a : r.choice === "b" ? c.sides.b : r.choice;
    tally[winner] = (tally[winner] || 0) + 1;
    compRows.push({ word: c.word, winner, unsure: !!r.unsure, note: r.note || "" });
  }
  out(`## Xidid vs Snowball groupings`);
  out();
  out(`Answered ${comps.length} of ${set.comparisons.length}. The reviewer saw the groups as A and B in shuffled order, without knowing which stemmer made which.`);
  out();
  out(`| Answer | Count |`);
  out(`| --- | --- |`);
  out(`| Xidid's grouping better | ${tally.xidid} |`);
  out(`| Snowball's grouping better | ${tally.snowball} |`);
  out(`| Both fine | ${tally["both-good"]} |`);
  out(`| Both wrong | ${tally["both-bad"]} |`);
  out();
  if (compRows.length) {
    out(`| Word | Better | Unsure | Note |`);
    out(`| --- | --- | --- | --- |`);
    for (const r of compRows) out(`| ${r.word} | ${r.winner} | ${r.unsure ? "yes" : ""} | ${r.note.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
    out();
  }

  // --- for session 3 ---
  const unsureGroups = set.groups.filter((g) => res.groups?.[g.id]?.unsure);
  const notes = [
    ...set.groups.filter((g) => res.groups?.[g.id]?.note).map((g) => `Group of *${g.forms[0].form}* (${g.id}): ${res.groups[g.id].note}`),
    ...set.comparisons.filter((c) => res.comparisons?.[c.id]?.note).map((c) => `Comparison *${c.word}* (${c.id}): ${res.comparisons[c.id].note}`),
  ];
  out(`## For the debrief (session 3)`);
  out();
  out(`Groups marked unsure: ${unsureGroups.length ? unsureGroups.map((g) => `*${g.forms.map((f) => f.form).slice(0, 3).join(", ")}*`).join("; ") : "none"}.`);
  out();
  if (notes.length) {
    out(`Reviewer notes:`);
    out();
    for (const n of notes) out(`- ${n.replace(/\n/g, " ")}`);
  } else out(`No notes.`);
  out();
}

// --- agreement between reviewers ---
if (results.length >= 2) {
  const [r1, r2] = results;
  let agreeForms = 0, totalForms = 0, agreeComps = 0, totalComps = 0;
  for (const g of set.groups) {
    const a = r1.groups?.[g.id], b = r2.groups?.[g.id];
    if (!a?.done || !b?.done) continue;
    const oa = new Set(a.outliers || []), ob = new Set(b.outliers || []);
    for (const f of g.forms) {
      totalForms++;
      if (oa.has(f.form) === ob.has(f.form)) agreeForms++;
    }
  }
  for (const c of set.comparisons) {
    const a = r1.comparisons?.[c.id]?.choice, b = r2.comparisons?.[c.id]?.choice;
    if (!a || !b) continue;
    totalComps++;
    if (a === b) agreeComps++;
  }
  out(`# Agreement between the first two reviewers`);
  out();
  out(`- Word forms (belongs / doesn't belong): ${agreeForms} of ${totalForms} (${pct(agreeForms, totalForms)})`);
  out(`- Comparisons (same answer): ${agreeComps} of ${totalComps} (${pct(agreeComps, totalComps)})`);
  out();
  out(`Disagreements are the best material for discussion: they mark the genuinely hard cases.`);
  out();
}

writeText(OUT, lines.join("\n") + "\n");
console.log(`Wrote ${OUT}`);
