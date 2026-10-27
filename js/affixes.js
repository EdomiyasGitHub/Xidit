// Prefix and suffix inventories for Somali affix stripping, ported 1:1
// from the Python somali_stemmer/affixes.py.
//
// Lists are exposed pre-sorted by length (longest first) so the stemmer
// always tries the longest, most specific affix match before falling
// back to shorter, higher-collision ones.

export const PREFIXES = ["la", "ku", "ka", "u"];

export const SUFFIXES = [
  "kayga", "tayda", "hayga", "dayda", "dayada", "kiisa", "tiisa", "haha", "hay",
  "doonayaan", "doonaysaa", "doonayaa", "doontaa", "doonaa",
  "aynayaa", "aynaynaa", "naysaa", "aysaa", "nayaan", "ayaan", "ayaa",
  "ayay", "ayey", "naya", "nayo",
  "yaasha", "yaha", "yada", "aanka", "iinka", "aada", "aha",
  "yaal", "yin", "yo", "aan", "ood", "oon",
  "teen", "naan", "ayna", "aysan", "een", "tay", "nay", "yay", "ay","ya",
  "kii", "tii", "dii", "gii",
  "ku", "tu", "su", "gu", "du",
  "ka", "ga", "ta", "da", "sha",
  "taa", "naa", "aa",
  "in",
  "o", "e", "na", "ba", "se",
];

function byLenDesc(list) {
  return [...list].sort((a, b) => b.length - a.length);
}

export const PREFIXES_BY_LEN = byLenDesc(PREFIXES);
export const SUFFIXES_BY_LEN = byLenDesc(SUFFIXES);
