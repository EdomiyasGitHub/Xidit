// A small vector-space IR engine built on top of the Somali stemmer.
//
// Pipeline (identical for documents and queries):
//   raw text -> tokenize -> mapTerm(token) -> index/query terms
//
// `mapTerm` is the pluggable step. The default is Xidid's lexicon-gated
// Somali stemmer (makeStemMapper); `rawMapper` only lowercases, giving an
// unstemmed baseline; makeSnowballMapper wraps the rules-only Snowball
// stemmer (js/snowball/), so the three can be compared on equal terms. The mapper is stored on the index,
// so a query is always processed exactly the way that index's documents
// were -- the two can never drift apart.
//
// Ranking: TF-IDF weighted vectors, ranked by cosine similarity.
// An inverted index (term -> postings) is used to find candidate
// documents quickly instead of scanning the whole corpus per query.

import { stem } from "./stemmer.js";
import { normalize } from "./textUtils.js";

const TOKEN_RE = /[\p{L}]+/gu;

/** Split raw text into word tokens (letters only, unicode-aware). */
export function tokenize(text) {
  return text.match(TOKEN_RE) || [];
}

// ---------------------------------------------------------------------
// Term mappers: token -> index term ("" means "skip this token")
// ---------------------------------------------------------------------

/**
 * Mapper that stems every token. Results are cached per mapper, so build
 * a fresh mapper whenever protected words / overrides / lexicon change.
 */
export function makeStemMapper(stemOpts = {}) {
  const cache = new Map();
  const mapTerm = (token) => {
    const key = token.toLowerCase();
    let term = cache.get(key);
    if (term === undefined) {
      term = stem(token, stemOpts);
      cache.set(key, term);
    }
    return term;
  };
  mapTerm.label = "stemmed";
  return mapTerm;
}

/**
 * Mapper backed by a Snowball-generated stemmer (an object with
 * stemWord()). Snowball stemmers expect lower-case input, so tokens are
 * normalised first, exactly as for the other mappers.
 */
export function makeSnowballMapper(snowballStemmer) {
  const cache = new Map();
  const mapTerm = (token) => {
    const key = normalize(token);
    if (!key) return "";
    let term = cache.get(key);
    if (term === undefined) {
      term = snowballStemmer.stemWord(key);
      cache.set(key, term);
    }
    return term;
  };
  mapTerm.label = "snowball";
  return mapTerm;
}

/** Baseline mapper: lowercase + strip non-letters, no stemming. */
export function rawMapper(token) {
  return normalize(token);
}
rawMapper.label = "raw";

// ---------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------

/**
 * Build the search index for a corpus of documents.
 *
 * @param {Array<{id:string, title:string, text:string}>} documents
 * @param {Function|object} mapTermOrStemOpts - a term mapper (see above);
 *   for backward compatibility a plain stemOpts object is also accepted
 *   and wrapped in makeStemMapper().
 * @returns {object} index
 */
export function buildIndex(documents, mapTermOrStemOpts = {}) {
  const mapTerm =
    typeof mapTermOrStemOpts === "function" ? mapTermOrStemOpts : makeStemMapper(mapTermOrStemOpts);
  const docCount = documents.length;

  // docId -> { title, text, terms: Map<term, count>, totalTerms, originalToStem: Map<token, term> }
  const docTermCounts = new Map();
  // term -> Set<docId>  (the inverted index / postings lists)
  const postings = new Map();

  for (const doc of documents) {
    const tokens = tokenize(doc.text);
    const termCounts = new Map();
    const originalToStem = new Map();
    let totalTerms = 0;

    for (const token of tokens) {
      const term = mapTerm(token);
      if (!term) continue;
      totalTerms++;
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
      originalToStem.set(token.toLowerCase(), term);

      if (!postings.has(term)) postings.set(term, new Set());
      postings.get(term).add(doc.id);
    }

    docTermCounts.set(doc.id, {
      title: doc.title,
      text: doc.text,
      terms: termCounts,
      // Only tokens that produced a term count towards document length.
      // (Cosine similarity cancels any per-document scaling, so this
      // doesn't change rankings -- but it makes the raw weights correct.)
      totalTerms,
      originalToStem,
    });
  }

  // Document frequency per term, then idf = ln(N / df).
  const df = new Map();
  for (const [term, docs] of postings) df.set(term, docs.size);

  const idf = new Map();
  for (const [term, count] of df) idf.set(term, Math.log(docCount / count));

  // TF-IDF weight vectors per document, plus their norm (for cosine sim).
  const docVectors = new Map();
  for (const [docId, info] of docTermCounts) {
    const vector = new Map();
    for (const [term, count] of info.terms) {
      const tf = count / info.totalTerms;
      vector.set(term, tf * (idf.get(term) || 0));
    }
    let normSq = 0;
    for (const w of vector.values()) normSq += w * w;
    docVectors.set(docId, { vector, norm: Math.sqrt(normSq) });
  }

  return {
    documents: docTermCounts,
    postings,
    df,
    idf,
    docVectors,
    docCount,
    mapTerm,
    mapperLabel: mapTerm.label || "custom",
  };
}

// ---------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------

/**
 * Turn a query into a TF-IDF vector using the index's own term mapper and
 * idf table. Shared by search() and explain() so the explanation is
 * computed with exactly the same arithmetic as the ranking.
 */
export function buildQueryVector(query, index) {
  const mapTerm = index.mapTerm;
  const tokens = tokenize(query);
  const trace = tokens.map((token) => {
    const term = mapTerm(token);
    return { token, term, stem: term }; // `stem` kept for older callers
  });

  const termCounts = new Map();
  let totalTerms = 0;
  for (const { term } of trace) {
    if (!term) continue;
    totalTerms++;
    termCounts.set(term, (termCounts.get(term) || 0) + 1);
  }

  const vector = new Map();
  for (const [term, count] of termCounts) {
    const tf = count / (totalTerms || 1);
    vector.set(term, tf * (index.idf.get(term) || 0));
  }
  let normSq = 0;
  for (const w of vector.values()) normSq += w * w;

  return { trace, termCounts, totalTerms, vector, norm: Math.sqrt(normSq) };
}

/**
 * Run a query against a built index, using that index's own term mapper.
 * Returns ranked results with scores and metadata for the UI.
 *
 * @param {string} query
 * @param {object} index - from buildIndex()
 * @param {{topk?: number}} opts - topk defaults to 10; Infinity = all matches
 */
export function search(query, index, opts = {}) {
  const topk = opts.topk ?? 10;
  const q = buildQueryVector(query, index);

  // Candidate documents: union of postings lists for query terms only,
  // via the inverted index -- not a full corpus scan.
  const candidateDocIds = new Set();
  for (const term of q.termCounts.keys()) {
    const docs = index.postings.get(term);
    if (docs) for (const id of docs) candidateDocIds.add(id);
  }

  const results = [];
  for (const docId of candidateDocIds) {
    const { vector: docVector, norm: docNorm } = index.docVectors.get(docId);
    if (docNorm === 0 || q.norm === 0) continue;

    let dot = 0;
    for (const [term, qWeight] of q.vector) {
      const dWeight = docVector.get(term);
      if (dWeight) dot += qWeight * dWeight;
    }
    const score = dot / (docNorm * q.norm);
    if (score > 0) {
      const docInfo = index.documents.get(docId);
      results.push({
        docId,
        title: docInfo.title,
        text: docInfo.text,
        score,
        matchedTerms: [...q.vector.keys()].filter((t) => docVector.has(t)),
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return {
    results: results.slice(0, topk),
    totalMatches: results.length,
    trace: q.trace,
    queryTermCount: q.termCounts.size,
  };
}

/**
 * Break one document's score for one query into per-term contributions.
 *
 *   score = cos(q, d) = sum_t (w_q,t * w_d,t) / (|q| * |d|)
 *   w_x,t = (count of t in x / terms in x) * ln(N / df_t)
 *
 * Each row's `contribution` is that term's share of the sum, already
 * divided by both norms, so the contributions add up to the score.
 *
 * Row status:
 *   "matched"        -- term is in the query and this document
 *   "not-in-doc"     -- term is in the index but not this document
 *   "not-in-index"   -- no document contains it (df = 0)
 *   "every-doc"      -- in every document, so idf = 0 and it can't help
 */
export function explain(query, docId, index) {
  const q = buildQueryVector(query, index);
  const doc = index.documents.get(docId);
  const dv = index.docVectors.get(docId);
  if (!doc || !dv) return null;

  // Surface forms in this document for each term, with counts.
  const formsByTerm = new Map();
  for (const token of tokenize(doc.text)) {
    const term = index.mapTerm(token);
    if (!term || !q.termCounts.has(term)) continue;
    const form = token.toLowerCase();
    if (!formsByTerm.has(term)) formsByTerm.set(term, new Map());
    const m = formsByTerm.get(term);
    m.set(form, (m.get(form) || 0) + 1);
  }

  const denom = q.norm * dv.norm;
  const rows = [...q.termCounts.keys()].map((term) => {
    const df = index.df.get(term) || 0;
    const idf = index.idf.get(term) || 0;
    const count = doc.terms.get(term) || 0;
    const docWeight = dv.vector.get(term) || 0;
    const queryWeight = q.vector.get(term) || 0;
    const contribution = denom > 0 ? (queryWeight * docWeight) / denom : 0;
    let status = "matched";
    if (df === 0) status = "not-in-index";
    else if (count === 0) status = "not-in-doc";
    else if (idf === 0) status = "every-doc";
    return {
      term,
      tokens: q.trace.filter((t) => t.term === term).map((t) => t.token),
      forms: [...(formsByTerm.get(term) || new Map()).entries()]
        .map(([form, n]) => ({ form, count: n }))
        .sort((a, b) => b.count - a.count || a.form.localeCompare(b.form)),
      count,
      docLength: doc.totalTerms,
      queryCount: q.termCounts.get(term),
      df,
      idf,
      docWeight,
      queryWeight,
      contribution,
      status,
    };
  });

  const score = rows.reduce((sum, r) => sum + r.contribution, 0);
  for (const r of rows) r.share = score > 0 ? r.contribution / score : 0;

  return {
    docId,
    title: doc.title,
    rows,
    score,
    docNorm: dv.norm,
    queryNorm: q.norm,
    queryLength: q.totalTerms,
    docCount: index.docCount,
    docLength: doc.totalTerms,
    distinctDocTerms: doc.terms.size,
  };
}

/**
 * Wrap occurrences of any word whose term is in matchTerms in <mark>.
 * Pass the index's mapper (index.mapTerm) so highlighting matches the
 * way the document was indexed.
 */
export function highlight(text, matchTerms, mapTerm) {
  if (matchTerms.length === 0) return escapeHtml(text);
  const matchSet = new Set(matchTerms);
  const toTerm = typeof mapTerm === "function" ? mapTerm : makeStemMapper(mapTerm || {});
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    out += escapeHtml(text.slice(last, m.index));
    const token = m[0];
    out += matchSet.has(toTerm(token)) ? `<mark>${escapeHtml(token)}</mark>` : escapeHtml(token);
    last = m.index + token.length;
  }
  return out + escapeHtml(text.slice(last));
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
