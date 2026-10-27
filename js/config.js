// Tuning knobs, ported 1:1 from the Python somali_stemmer/config.py.

export const MIN_STEM_LEN = 3;
export const MAX_SUFFIX_PASSES = 2;

// If true, prefix stripping (ku/ka/la/u) only happens when the resulting
// stem can be confirmed against the protected-word list or the lexicon.
// ku, ka, la, u are largely separate preverbal particles in Somali, not
// fused prefixes -- stripping them blindly truncates ordinary words that
// merely *start* with those letters (e.g. "karin", "kaba").
export const PREFIX_STRIP_REQUIRES_LEXICON = true;

export const DEFAULT_NGRAM_SIZES = [2, 3, 4];

export const VOWELS = ["a", "e", "i", "o", "u"];
export const NGRAM_FALLBACK_MIN_SCORE = 0.72;
export const NGRAM_FALLBACK_MAX_LEN_DIFF = 2;
