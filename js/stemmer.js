// Core affix-stripping logic. Originally a 1:1 port of the Python
// somali_stemmer/stemmer.py, since extended with two fallback layers the
// Python CLI doesn't have (see below) -- this file is now the more capable
// of the two.
//
// Design: when a lexicon of known words is supplied, every candidate stem
// must be confirmed before it's accepted, in increasing order of how much
// the stemmer is willing to guess:
//
//   1. direct match        -- candidate is exactly a known word
//   2. vowel-repair match  -- Somali roots often swap their final vowel
//                             (or drop an epenthetic one) when a suffix
//                             attaches, e.g. hooyo -> hooya-hay, fur ->
//                             fura-hayga. A straight substring strip lands
//                             on "hooya"/"fura", which aren't themselves
//                             words. Try the small set of vowel repairs
//                             before giving up.
//   3. n-gram fallback     -- if neither of the above confirms anything,
//                             look for the nearest lexicon word by
//                             character n-gram overlap (ngram.js). Only
//                             accepted when the match is close (high
//                             similarity, small length difference) --
//                             calibration below.
//
// This still avoids the classic overstemming failure mode of blind
// longest-suffix-match stemmers (chopping anything that happens to end in
// a suffix-shaped sequence); it just tries harder before declaring defeat.
//
// Without a lexicon, the stemmer falls back to blind longest-match (useful
// for quick testing without any data files; not recommended for production
// search matching, since it will over-strip).

import { MIN_STEM_LEN, MAX_SUFFIX_PASSES, PREFIX_STRIP_REQUIRES_LEXICON, VOWELS, NGRAM_FALLBACK_MIN_SCORE, NGRAM_FALLBACK_MAX_LEN_DIFF } from "./config.js";
import { PREFIXES_BY_LEN, SUFFIXES_BY_LEN } from "./affixes.js";
import { normalize } from "./textUtils.js";
import { rank as ngramRank } from "./ngram.js";

// lexicon is either null (no lexicon supplied -> blind longest-match
// fallback) or a Set (possibly empty, which behaves the same as null).

function isConfirmed(word, protectedSet, lexicon) {
  return protectedSet.has(word) || Boolean(lexicon && lexicon.has(word));
}

function normalizeLexicon(lexicon) {
  if (!lexicon || lexicon.size === 0) return null;
  return lexicon;
}

/**
 * Somali roots commonly change shape at the point a suffix attaches, in
 * ways a plain substring strip doesn't undo. Given a substring-stripped
 * candidate that isn't itself a known word, generate the small set of
 * "repaired" alternatives worth checking against the lexicon:
 *
 *  - candidate ends in a vowel: Somali nouns/verbs often swap or drop
 *    that final vowel when a possessive/nominalizing suffix attaches
 *    (hooyo -> hooya-hay, fur -> fura-hayga) -- try every other vowel,
 *    and dropping it entirely.
 *  - candidate ends in a consonant: some CVC roots carry an epenthetic
 *    vowel that a suffix-strip can leave stranded (orod -> ord-aya) --
 *    try re-inserting a vowel just before the final consonant.
 */
function vowelRepairCandidates(word) {
  if (word.length === 0) return [];
  const last = word[word.length - 1];
  const variants = [];

  if (VOWELS.includes(last)) {
    for (const v of VOWELS) {
      if (v !== last) variants.push(word.slice(0, -1) + v);
    }
    if (word.length - 1 >= MIN_STEM_LEN) variants.push(word.slice(0, -1));
  } else {
    for (const v of VOWELS) {
      variants.push(word.slice(0, -1) + v + last);
    }
  }
  return variants;
}

/**
 * Last-resort fallback: is there a lexicon word close enough by n-gram
 * overlap to accept as this candidate's stem? Deliberately conservative --
 * plain nearest-neighbor search tends to prefer minimally-different
 * inflected forms over the true root (e.g. "qoris" -> "qori", a real but
 * different word, rather than "qor"), so this only ever fires when direct
 * and vowel-repair matching both failed, and only accepts a match that's
 * both high-similarity and close in length.
 */
function ngramFallback(candidate, ngramIndex) {
  if (!ngramIndex || candidate.length < MIN_STEM_LEN) return null;
  const [top] = ngramRank(candidate, ngramIndex, undefined, 1);
  if (!top) return null;
  const [word, score] = top;
  if (score >= NGRAM_FALLBACK_MIN_SCORE && Math.abs(word.length - candidate.length) <= NGRAM_FALLBACK_MAX_LEN_DIFF) {
    return { word, score };
  }
  return null;
}

/**
 * Try to strip a single suffix, escalating through direct / vowel-repair /
 * n-gram confirmation. Returns [result, changed, method].
 */
function stripSuffixOnce(word, protectedSet, lexicon, ngramIndex) {
  if (protectedSet.has(word)) return [word, false, null];

  const candidates = [];
  for (const suffix of SUFFIXES_BY_LEN) {
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM_LEN) {
      candidates.push(word.slice(0, word.length - suffix.length));
    }
  }
  if (candidates.length === 0) return [word, false, null];

  // Pass 1: a candidate confirmed exactly as-is.
  for (const candidate of candidates) {
    if (isConfirmed(candidate, protectedSet, lexicon)) return [candidate, true, "direct"];
  }

  // Pass 2: vowel-repaired variant of a candidate confirmed.
  for (const candidate of candidates) {
    for (const repaired of vowelRepairCandidates(candidate)) {
      if (isConfirmed(repaired, protectedSet, lexicon)) return [repaired, true, "vowel-repair"];
    }
  }

  // Pass 3: n-gram nearest-neighbor fallback, tried on the most specific
  // (longest-suffix-stripped) candidate only -- but never if `word` itself
  // (the thing we're trying to strip a suffix from) is already a
  // confirmed dictionary word. In that case we already have a solid
  // answer; a weak nearest-neighbor guess must not override it (this is
  // what previously turned the already-good word "xoolo" into "xoola").
  if (lexicon !== null && !isConfirmed(word, protectedSet, lexicon)) {
    const near = ngramFallback(candidates[0], ngramIndex);
    if (near) return [near.word, true, `ngram-fallback (similarity ${near.score.toFixed(2)})`];
  }

  // No lexicon supplied at all -> fall back to blind longest match.
  if (lexicon === null) return [candidates[0], true, "blind"];

  // Nothing confirmed -> don't guess.
  return [word, false, null];
}

export function stripSuffixes(word, protectedSet, lexicon, ngramIndex) {
  let lastMethod = null;
  for (let i = 0; i < MAX_SUFFIX_PASSES; i++) {
    const [next, changed, method] = stripSuffixOnce(word, protectedSet, lexicon, ngramIndex);
    word = next;
    if (!changed) break;
    lastMethod = method;

    // Stop as soon as this pass lands on a word that's itself directly
    // confirmed in the lexicon/protected list. Further passes risk
    // over-stripping a legitimate root that happens to *end* in a
    // suffix-shaped sequence -- e.g. "hooyo" (mother, already a root)
    // ends in the listed suffix "yo", and "hoo" is coincidentally also a
    // real (unrelated) word, so an unconditional second pass would wrongly
    // reduce "hooyo" to "hoo". A word reached by direct/vowel-repair/
    // ngram confirmation is already as far as we should go.
    if (isConfirmed(word, protectedSet, lexicon)) break;
  }
  return [word, lastMethod];
}

/**
 * Try to strip one leading particle (ku/ka/la/u). Returns [result, changed, method].
 * Gated behind lexicon confirmation by default -- see
 * PREFIX_STRIP_REQUIRES_LEXICON for why.
 */
export function stripPrefix(word, protectedSet, lexicon, ngramIndex) {
  if (protectedSet.has(word)) return [word, false, null];

  for (const prefix of PREFIXES_BY_LEN) {
    if (word.startsWith(prefix) && word.length - prefix.length >= MIN_STEM_LEN) {
      const candidate = word.slice(prefix.length);
      if (isConfirmed(candidate, protectedSet, lexicon)) return [candidate, true, "direct"];
      for (const repaired of vowelRepairCandidates(candidate)) {
        if (isConfirmed(repaired, protectedSet, lexicon)) return [repaired, true, "vowel-repair"];
      }
      if (lexicon !== null && !isConfirmed(word, protectedSet, lexicon)) {
        const near = ngramFallback(candidate, ngramIndex);
        if (near) return [near.word, true, `ngram-fallback (similarity ${near.score.toFixed(2)})`];
      }
      if (lexicon === null && !PREFIX_STRIP_REQUIRES_LEXICON) return [candidate, true, "blind"];
    }
  }
  return [word, false, null];
}

/**
 * Collapse a reduplicated final syllable (last letter echoes an earlier
 * one across an "a", e.g. trailing "...Xa" + "X").
 */
export function undoReduplication(word) {
  if (word.length >= 5 && word[word.length - 2] === "a" && word[word.length - 1] === word[word.length - 3]) {
    return word.slice(0, word.length - 2);
  }
  return word;
}

/**
 * Stem a single word.
 *
 * @param {string} word
 * @param {object} [opts]
 * @param {Set<string>} [opts.protected] - words that should never be stemmed
 * @param {Map<string,string>} [opts.overrides] - irregular word -> stem
 * @param {Set<string>|null} [opts.lexicon] - known-good words, used to
 *   validate candidate stems. Omit/null for blind longest-match fallback.
 * @param {Map<string,Set<string>>} [opts.ngramIndex] - precomputed n-gram
 *   profile index over the lexicon (see ngram.js buildIndex), used for the
 *   last-resort fallback. Omit to disable that fallback.
 * @returns {string}
 */
export function stem(word, opts = {}) {
  const protectedSet = opts.protected instanceof Set ? opts.protected : new Set();
  const overrides = opts.overrides instanceof Map ? opts.overrides : null;
  const lexicon = normalizeLexicon(opts.lexicon ?? null);
  const ngramIndex = opts.ngramIndex ?? null;

  const normalized = normalize(word);

  if (overrides && overrides.has(normalized)) return overrides.get(normalized);
  if (protectedSet.has(normalized)) return normalized;
  if (normalized.length <= MIN_STEM_LEN) return normalized;

  const [suffixStripped] = stripSuffixes(normalized, protectedSet, lexicon, ngramIndex);
  const withoutPrefix = undoReduplication(suffixStripped);

  const [prefixed, prefixChanged] = stripPrefix(normalized, protectedSet, lexicon, ngramIndex);
  let withPrefix = null;
  if (prefixChanged) {
    const [prefixSuffixStripped] = stripSuffixes(prefixed, protectedSet, lexicon, ngramIndex);
    withPrefix = undoReduplication(prefixSuffixStripped);
  }

  if (withPrefix === null) return withoutPrefix;

  // Both a prefix-stripped and a prefix-kept reading exist. If the reading
  // WITHOUT prefix stripping is a confirmed word, keep it.
  //
  // Xidid change (deviates from the Python somali_stemmer): the original
  // preferred the prefix-stripped reading whenever both were confirmed,
  // reasoning that it "made more progress toward the root". In practice
  // that truncated ordinary words that merely start with ku/ka/la/u and
  // whose remainder happens to be another word: lacag 'money' -> cag
  // 'foot', ubax 'flower' -> bax 'go out', kariyo 'cooked' -> riyo 'dream',
  // kursi 'chair' -> rse. 29 forms in the corpus were affected. Prefix
  // stripping now only wins when the prefix-kept reading is NOT a word.
  const withoutConfirmed = isConfirmed(withoutPrefix, protectedSet, lexicon);
  if (withoutConfirmed) return withoutPrefix;
  return withPrefix;
}

/** Stem whitespace-separated text, returning an array of stems. */
export function stemText(text, opts = {}) {
  return text
    .split(/\s+/)
    .filter((w) => w.trim().length > 0)
    .map((w) => stem(w, opts));
}

/**
 * Same as stem(), but also returns the intermediate candidates and which
 * fallback layer (if any) confirmed the result, so the UI can show how the
 * result was reached.
 */
export function stemVerbose(word, opts = {}) {
  const protectedSet = opts.protected instanceof Set ? opts.protected : new Set();
  const overrides = opts.overrides instanceof Map ? opts.overrides : null;
  const lexicon = normalizeLexicon(opts.lexicon ?? null);
  const ngramIndex = opts.ngramIndex ?? null;

  const normalized = normalize(word);
  const trace = { word, normalized, lexiconActive: lexicon !== null };

  if (overrides && overrides.has(normalized)) {
    return { ...trace, result: overrides.get(normalized), reason: "override" };
  }
  if (protectedSet.has(normalized)) {
    return { ...trace, result: normalized, reason: "protected" };
  }
  if (normalized.length <= MIN_STEM_LEN) {
    return { ...trace, result: normalized, reason: "too-short" };
  }

  const [suffixStripped, suffixMethod] = stripSuffixes(normalized, protectedSet, lexicon, ngramIndex);
  const withoutPrefix = undoReduplication(suffixStripped);

  const [prefixed, prefixChanged, prefixMethod] = stripPrefix(normalized, protectedSet, lexicon, ngramIndex);
  let withPrefix = null;
  let withPrefixSuffixMethod = null;
  if (prefixChanged) {
    const [prefixSuffixStripped, m] = stripSuffixes(prefixed, protectedSet, lexicon, ngramIndex);
    withPrefix = undoReduplication(prefixSuffixStripped);
    withPrefixSuffixMethod = m;
  }

  const withoutConfirmed = isConfirmed(withoutPrefix, protectedSet, lexicon);
  const withPrefixConfirmed = withPrefix !== null && isConfirmed(withPrefix, protectedSet, lexicon);

  let result, reason, method;
  if (withPrefix === null) {
    result = withoutPrefix;
    reason = "suffix-only";
    method = suffixMethod;
  } else if (withoutConfirmed) {
    // See stem(): the prefix-kept reading wins whenever it is a word.
    result = withoutPrefix;
    reason = "suffix-only-confirmed";
    method = suffixMethod;
  } else {
    result = withPrefix;
    reason = "prefix-and-suffix";
    method = prefixMethod || withPrefixSuffixMethod;
  }

  return {
    ...trace,
    withoutPrefix,
    withPrefix,
    withoutConfirmed,
    withPrefixConfirmed,
    result,
    reason,
    method, // null | "direct" | "vowel-repair" | "ngram-fallback (similarity 0.xx)" | "blind"
  };
}