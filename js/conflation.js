// Conflation classes: which surface forms in the corpus collapse into
// the same index term.
//
// A stemmer's whole job is conflation -- mapping many word forms onto one
// index term. This module measures it directly on the loaded corpus:
//
//   term -> { forms: Map<form, {count, docs:Set}>, count, docs:Set }
//
// plus corpus-level statistics (tokens, distinct forms, distinct terms,
// vocabulary reduction). It reuses the index's own term mapper, so what
// it reports is exactly what the search engine does.
//
// Counting rule (documented because the numbers appear in the UI):
//   - a "token" is a run of letters (same tokenizer as ir.js) whose
//     mapped term is non-empty;
//   - a "form" is a token lowercased (two spellings differing only in
//     case are the same form);
//   - "stems" are the distinct terms produced by the mapper.

import { tokenize } from "./ir.js";

/**
 * @param {Array<{id:string, text:string}>} documents
 * @param {Function} mapTerm - normally index.mapTerm
 */
export function buildConflation(documents, mapTerm) {
  const classes = new Map(); // term -> class
  const formToTerm = new Map(); // form -> term
  let tokenCount = 0;

  for (const doc of documents) {
    for (const token of tokenize(doc.text)) {
      const term = mapTerm(token);
      if (!term) continue;
      tokenCount++;
      const form = token.toLowerCase();
      formToTerm.set(form, term);

      let cls = classes.get(term);
      if (!cls) {
        cls = { term, forms: new Map(), count: 0, docs: new Set() };
        classes.set(term, cls);
      }
      cls.count++;
      cls.docs.add(doc.id);

      let f = cls.forms.get(form);
      if (!f) {
        f = { count: 0, docs: new Set() };
        cls.forms.set(form, f);
      }
      f.count++;
      f.docs.add(doc.id);
    }
  }

  const formCount = formToTerm.size;
  const termCount = classes.size;
  let mergedClasses = 0; // terms that absorbed 2+ forms
  for (const cls of classes.values()) if (cls.forms.size > 1) mergedClasses++;

  return {
    classes,
    formToTerm,
    stats: {
      documents: documents.length,
      tokens: tokenCount,
      forms: formCount,
      terms: termCount,
      reduction: formCount ? (formCount - termCount) / formCount : 0,
      mergedClasses,
      tokensPerDoc: documents.length ? tokenCount / documents.length : 0,
    },
  };
}

/** The n classes with the most distinct forms (ties: more occurrences first). */
export function largestClasses(conflation, n = 15) {
  return [...conflation.classes.values()]
    .sort((a, b) => b.forms.size - a.forms.size || b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, n);
}

/**
 * Resolve user input to a conflation class.
 *
 * Default ("word") mode treats the input the way search does: it is run
 * through the mapper first, so "saacadaha" and "saacad" both land on the
 * class "saacad".
 *
 * A stemmer isn't always idempotent: "lacag" maps to "cag", yet other
 * forms ("lacagaha") map to "lacag", making "lacag" an index term in its
 * own right. When that happens the second class is returned as `also`,
 * because it's exactly the kind of inconsistency worth showing.
 *
 * With { exactTerm: true } the input is taken as an index term as-is
 * (used when clicking a class in the "largest classes" list).
 *
 * Returns { input, term, viaMapping, cls, also } -- cls is null if the
 * term never occurs in the corpus; also is null or { term, cls }.
 */
export function lookupClass(conflation, input, mapTerm, { exactTerm = false } = {}) {
  const word = input.trim();
  if (!word) return null;
  const lower = word.toLowerCase();

  if (exactTerm && conflation.classes.has(lower)) {
    return { input: word, term: lower, viaMapping: false, cls: conflation.classes.get(lower), also: null };
  }

  const term = mapTerm(word);
  const cls = term ? conflation.classes.get(term) || null : null;
  const also =
    term !== lower && conflation.classes.has(lower) ? { term: lower, cls: conflation.classes.get(lower) } : null;
  return { input: word, term, viaMapping: term !== lower, cls, also };
}

/** How many index terms are not stable under their own mapping (mapTerm(t) !== t). */
export function unstableTerms(conflation, mapTerm) {
  const out = [];
  for (const term of conflation.classes.keys()) {
    const again = mapTerm(term);
    if (again !== term) out.push({ term, mapsTo: again });
  }
  return out;
}

/** Forms of a class, most frequent first. */
export function sortedForms(cls) {
  return [...cls.forms.entries()]
    .map(([form, f]) => ({ form, count: f.count, docs: f.docs.size }))
    .sort((a, b) => b.count - a.count || a.form.localeCompare(b.form));
}
