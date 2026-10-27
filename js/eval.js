// Offline evaluation: pooled relevance judgments and standard IR metrics.
//
// Test collection = queries + relevance judgments ("qrels"). Judgments
// are made on a *pool*: the union of the top-k documents from every
// system being compared (here: raw and stemmed), as in TREC. Documents
// outside the pool are unjudged and, by convention, count as
// non-relevant -- so recall is relative to what the pooled systems found.
//
// qrels format (data/qrels.json):
// {
//   "version": 1,
//   "poolDepth": 10,
//   "judge": "", "notes": "",
//   "queries": [
//     { "id": "q01", "text": "dugsi", "gloss": "school",
//       "need": "Documents about schools or schooling",
//       "judgments": { "sopc-v2-255": { "rel": 1, "unsure": false }, ... } }
//   ]
// }
// rel: 1 = relevant, 0 = not relevant. A document missing from
// `judgments` is unjudged.

import { search } from "./ir.js";

export const DEFAULT_POOL_DEPTH = 10;

/** Union of the top-`depth` results of each index, in a stable blind order. */
export function buildPool(queryText, indexes, depth = DEFAULT_POOL_DEPTH) {
  const ids = new Set();
  for (const index of indexes) {
    for (const r of search(queryText, index, { topk: depth }).results) ids.add(r.docId);
  }
  // Order by a hash of the id, not by system or score, so the judge
  // can't tell which configuration retrieved which document.
  return [...ids].sort((a, b) => hash(a) - hash(b) || a.localeCompare(b));
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Set of relevant docIds for one query. */
export function relevantSet(q) {
  return new Set(
    Object.entries(q.judgments || {})
      .filter(([, j]) => j && j.rel === 1)
      .map(([id]) => id)
  );
}

/**
 * Metrics for one ranked list (array of docIds, best first).
 *  P@k        relevant in top k / k
 *  R@10       relevant in top 10 / all known relevant
 *  AP         mean of P@rank over the ranks where a relevant doc appears,
 *             divided by all known relevant (unretrieved relevant docs
 *             contribute 0)
 *  pAtRank    P@1 .. P@10 (for the precision-by-rank chart)
 * Recall and AP are null when the query has no known relevant document.
 */
export function rankMetrics(ranking, relevant) {
  const R = relevant.size;
  let hits = 0;
  let apSum = 0;
  const pAtRank = [];
  for (let i = 0; i < ranking.length; i++) {
    if (relevant.has(ranking[i])) {
      hits++;
      apSum += hits / (i + 1);
    }
    if (i < 10) pAtRank.push(hits / (i + 1));
  }
  // Short rankings: precision at ranks beyond the list keeps dividing by k.
  for (let k = pAtRank.length + 1; k <= 10; k++) {
    const h = ranking.slice(0, k).filter((id) => relevant.has(id)).length;
    pAtRank.push(h / k);
  }
  const relIn = (k) => ranking.slice(0, k).filter((id) => relevant.has(id)).length;
  return {
    p5: relIn(5) / 5,
    p10: relIn(10) / 10,
    r10: R ? relIn(10) / R : null,
    ap: R ? apSum / R : null,
    pAtRank,
    retrieved: ranking.length,
  };
}

/**
 * Evaluate every *fully judged* query against each named index.
 *
 * @param {object} qrels
 * @param {Object<string, object>} indexes - e.g. { raw, stemmed }
 * @param {Set<string>} knownDocIds - ids in the current corpus (for validation)
 */
export function evaluate(qrels, indexes, knownDocIds) {
  const depth = qrels.poolDepth || DEFAULT_POOL_DEPTH;
  const names = Object.keys(indexes);
  const warnings = [];
  const perQuery = [];

  for (const q of qrels.queries || []) {
    for (const id of Object.keys(q.judgments || {})) {
      if (!knownDocIds.has(id)) warnings.push(`Query "${q.text}" has a judgment for "${id}", which is not in the corpus.`);
    }
    const pool = buildPool(q.text, names.map((n) => indexes[n]), depth);
    const judged = pool.filter((id) => q.judgments && q.judgments[id]);
    const complete = pool.length > 0 && judged.length === pool.length;
    const relevant = relevantSet(q);

    const row = {
      id: q.id,
      text: q.text,
      gloss: q.gloss || "",
      need: q.need || "",
      poolSize: pool.length,
      judgedCount: judged.length,
      complete,
      relevantCount: relevant.size,
      unsureCount: Object.values(q.judgments || {}).filter((j) => j && j.unsure).length,
      byConfig: {},
    };
    for (const name of names) {
      const ranking = search(q.text, indexes[name], { topk: Infinity }).results.map((r) => r.docId);
      row.byConfig[name] = rankMetrics(ranking, relevant);
    }
    perQuery.push(row);
  }

  // Averages over complete queries; recall/AP over those with >= 1 relevant.
  const done = perQuery.filter((r) => r.complete);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const summary = {};
  for (const name of names) {
    const withRel = done.filter((r) => r.relevantCount > 0);
    summary[name] = {
      p5: mean(done.map((r) => r.byConfig[name].p5)),
      p10: mean(done.map((r) => r.byConfig[name].p10)),
      r10: mean(withRel.map((r) => r.byConfig[name].r10)),
      map: mean(withRel.map((r) => r.byConfig[name].ap)),
      pAtRank: Array.from({ length: 10 }, (_, k) => mean(done.map((r) => r.byConfig[name].pAtRank[k]))),
    };
  }

  return {
    perQuery,
    summary,
    completeCount: done.length,
    withRelevantCount: done.filter((r) => r.relevantCount > 0).length,
    totalQueries: perQuery.length,
    warnings,
  };
}

/** Basic shape check for an imported qrels object; throws with a readable message. */
export function validateQrels(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.queries)) {
    throw new Error('expected an object with a "queries" array');
  }
  data.queries.forEach((q, i) => {
    if (!q || typeof q.text !== "string" || !q.text.trim()) throw new Error(`query #${i + 1} has no "text"`);
    if (q.judgments && typeof q.judgments !== "object") throw new Error(`query "${q.text}": "judgments" must be an object`);
  });
  return {
    version: 1,
    poolDepth: Number(data.poolDepth) || DEFAULT_POOL_DEPTH,
    judge: data.judge || "",
    notes: data.notes || "",
    queries: data.queries.map((q, i) => ({
      id: q.id || `q${String(i + 1).padStart(2, "0")}`,
      text: q.text.trim(),
      gloss: q.gloss || "",
      need: q.need || "",
      judgments: { ...(q.judgments || {}) },
    })),
  };
}
