// Character n-gram indexing and fuzzy matching. Ported from ngram.py.
//
// This is an optional, advisory layer: when the rule-based stemmer can't
// confirm a candidate against the lexicon (e.g. an unlisted suffix, a
// typo, a loanword), this suggests the closest known word by n-gram
// overlap. It never overrides the rule-based stemmer's output
// automatically.

import { DEFAULT_NGRAM_SIZES } from "./config.js";

export function ngrams(word, n) {
  const padded = `$${word}$`;
  const out = new Set();
  for (let i = 0; i <= padded.length - n; i++) {
    out.add(padded.slice(i, i + n));
  }
  return out;
}

export function ngramProfile(word, sizes = DEFAULT_NGRAM_SIZES) {
  const profile = new Set();
  for (const n of sizes) {
    for (const g of ngrams(word, n)) profile.add(g);
  }
  return profile;
}

export function buildIndex(lexicon, sizes = DEFAULT_NGRAM_SIZES) {
  const index = new Map();
  for (const w of lexicon) index.set(w, ngramProfile(w, sizes));
  return index;
}

export function diceScore(a, b) {
  if (a.size === 0 || b.size === 0) return 0.0;
  let overlap = 0;
  for (const g of a) if (b.has(g)) overlap++;
  return (2.0 * overlap) / (a.size + b.size);
}

export function rank(query, index, sizes = DEFAULT_NGRAM_SIZES, topk = 5) {
  const qProfile = ngramProfile(query, sizes);
  const scored = [];
  for (const [w, profile] of index) {
    const score = diceScore(qProfile, profile);
    if (score > 0) scored.push([w, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, topk);
}
