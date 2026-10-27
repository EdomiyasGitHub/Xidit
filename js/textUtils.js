// Small text-normalization helper shared across the app.
// Ported from text_utils.py: lowercase a word and strip anything that
// isn't a letter (unicode-aware, matching Python's str.isalpha()).

const LETTER_RE = /\p{L}/u;

export function normalize(word) {
  let out = "";
  for (const ch of word.toLowerCase()) {
    if (LETTER_RE.test(ch)) out += ch;
  }
  return out;
}
