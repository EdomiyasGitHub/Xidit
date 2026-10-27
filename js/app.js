import { stemVerbose } from "./stemmer.js";
import { buildIndex as buildNgramIndex, rank as ngramRank } from "./ngram.js";
import { buildIndex, search, highlight, explain, makeStemMapper, makeSnowballMapper, rawMapper } from "./ir.js";
import SomaliSnowballStemmer from "./snowball/somali-stemmer.js";
import { normalize } from "./textUtils.js";
import { buildConflation, largestClasses, lookupClass, sortedForms, unstableTerms } from "./conflation.js";
import { evaluate, buildPool, validateQrels, DEFAULT_POOL_DEPTH } from "./eval.js";
import { groupedBarChart, divergingBarChart, precisionAtRankChart } from "./charts.js";

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
//
// Everything here lives in memory only. There's no backend, so nothing
// the "Add" forms below do is written back to the JSON files in data/ --
// data/*.json is read once on load via fetch() and never touched again.
// That means edits (protected words, overrides, corpus documents) last
// for the current tab only and are gone on refresh. The Download buttons
// (save a new copy of the JSON) and Import buttons (load a JSON file back
// in) are how you carry edits across sessions without a server.

// The three configurations Xidid can compare. `stemmed` is Xidid's own
// lexicon-gated stemmer; `snowball` is the rules-only port in js/snowball/.
const CONFIGS = {
  raw: { label: "Raw", long: "unstemmed search", termHeader: "Raw term" },
  stemmed: { label: "Xidid", long: "Xidid stemmer", termHeader: "Xidid term" },
  snowball: { label: "Snowball", long: "Snowball stemmer", termHeader: "Snowball term" },
};
const snowballStemmer = new SomaliSnowballStemmer();

const state = {
  protected: new Set(),
  overrides: new Map(),
  lexicon: new Set(),
  documents: [],
  defaultDocuments: [],
  index: null, // stemmed index (the real search engine)
  rawIndex: null, // unstemmed baseline, for comparison
  snowballIndex: null, // rules-only Snowball stemmer, for comparison
  conflations: {}, // { stemmed, snowball } conflation data
  confView: "stemmed", // which stemmer the Conflation tab shows
  conflation: null, // which word forms share each stem
  unstable: [], // index terms t where stem(t) !== t
  lastQuery: "", // the query the visible results belong to
  qrels: null, // relevance judgments in use (see eval.js for the format)
  qrelsFile: null, // data/qrels.json as loaded, for "Reset"
  qrelsSource: "file", // "file" | "browser" | "import"
  evaluation: null, // cached evaluate() result; null = recompute
  evalView: "results", // "results" | "judge"
  judgeQuery: 0, // index of the query being judged
  evalPair: "stemmed-raw", // which pair the per-query chart compares
  reviewSet: null, // data/review-set.json, if present
  review: null, // the reviewer's answers
  reviewView: "practice", // "practice" | "groups" | "comparisons"
  reviewIndex: { practice: 0, groups: 0, comparisons: 0 },
  ngramIndex: null, // built once from the lexicon, reused by both tabs
};

function stemOpts({ useNgram = false } = {}) {
  return {
    protected: state.protected,
    overrides: state.overrides,
    lexicon: state.lexicon,
    ngramIndex: useNgram ? state.ngramIndex : null,
  };
}

function rebuildIrIndex() {
  // A fresh stem mapper every rebuild, so its cache never holds stems
  // computed under old protected words / overrides.
  state.index = buildIndex(state.documents, makeStemMapper(stemOpts()));
  state.rawIndex = buildIndex(state.documents, rawMapper);
  state.snowballIndex = buildIndex(state.documents, makeSnowballMapper(snowballStemmer));
  state.conflations = {
    stemmed: buildConflation(state.documents, state.index.mapTerm),
    snowball: buildConflation(state.documents, state.snowballIndex.mapTerm),
  };
  state.conflation = state.conflations[state.confView];
  renderCorpusStats();
  renderCorpusList();
  renderExplorer();
  // Pools and rankings depend on the index, so metrics must be redone.
  if (state.qrels) onEvalDataChanged();
}

// Called whenever protected words or overrides change: the index (and
// any visible results) must reflect the new stemmer configuration.
function indexFor(config) {
  return { raw: state.rawIndex, stemmed: state.index, snowball: state.snowballIndex }[config];
}

function configOf(index) {
  if (index === state.rawIndex) return "raw";
  if (index === state.snowballIndex) return "snowball";
  return "stemmed";
}

function onStemmerConfigChanged() {
  if (!state.index) return;
  rebuildIrIndex();
  if (searchInput.value.trim()) runSearch();
}

function rebuildNgramIndex() {
  state.ngramIndex = state.lexicon.size > 0 ? buildNgramIndex([...state.lexicon]) : null;
}

// ---------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------

async function loadJson(path) {
  // The single-file build (tools/build-single-file.mjs) inlines the data
  // files into window.__XIDID_DATA__, because a hosted single page can't
  // fetch neighbouring files. Everywhere else they are fetched as usual.
  const inlined = window.__XIDID_DATA__;
  if (inlined && Object.prototype.hasOwnProperty.call(inlined, path)) return structuredClone(inlined[path]);
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function init() {
  const statusEl = document.getElementById("load-status");
  try {
    const [protectedWords, overridePairs, lexiconWords, corpus] = await Promise.all([
      loadJson("data/protected_words.json"),
      loadJson("data/stem_overrides.json"),
      loadJson("data/somali_words.json"),
      loadJson("data/corpus.json"),
    ]);

    // Normalize every word on load, matching the Python CLI's
    // data_store.py exactly. Without this, a lexicon entry containing an
    // apostrophe (Somali's glottal stop, e.g. "da'ayso") could never be
    // matched again -- normalize() strips the apostrophe from every word
    // passed *into* the stemmer, but the raw JSON entry would still have
    // it, so Set membership checks would silently always miss.
    state.protected = new Set(protectedWords.map(normalize).filter(Boolean));
    state.overrides = new Map(
      Object.entries(overridePairs)
        .map(([k, v]) => [normalize(k), normalize(v)])
        .filter(([k, v]) => k && v)
    );
    state.lexicon = new Set(lexiconWords.map(normalize).filter(Boolean));
    state.documents = corpus.map((d) => ({ ...d }));
    state.defaultDocuments = corpus.map((d) => ({ ...d }));

    // Relevance judgments are optional: a missing or broken qrels.json
    // must not stop the rest of the app from working.
    try {
      state.qrelsFile = validateQrels(await loadJson("data/qrels.json"));
    } catch (err) {
      console.warn(`data/qrels.json not loaded (${err.message}); starting with no judgments.`);
      state.qrelsFile = emptyQrels();
    }
    // The review set is optional too (only needed for the Review tab).
    try {
      state.reviewSet = await loadJson("data/review-set.json");
    } catch (err) {
      console.warn(`data/review-set.json not loaded (${err.message}); the Review tab will be empty.`);
      state.reviewSet = null;
    }
    state.review = loadReview();

    const saved = loadSavedQrels();
    state.qrels = saved || validateQrels(JSON.parse(JSON.stringify(state.qrelsFile)));
    state.qrelsSource = saved ? "browser" : "file";

    statusEl.remove();
    rebuildNgramIndex();
    rebuildIrIndex();
    renderProtectedList();
    renderOverridesList();
    // A direct link (e.g. #review) may have shown its tab before the data
    // arrived; draw it again now that everything is loaded.
    if (!appEl.hidden) activateTab(currentTab());
  } catch (err) {
    statusEl.textContent = `Couldn't load data files (${err.message}). If you opened index.html directly, run a local server instead — see README.md.`;
    statusEl.classList.add("load-error");
  }
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------

function activateTab(name) {
  // Keep the address in step with the visible tab, so a reload or a shared
  // link (e.g. .../#review for a reviewer) opens the same place.
  if (!appEl.hidden && location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  // Charts are sized to their container, which has no width while hidden.
  if (name === "eval") renderEval();
  if (name === "review") renderReview();
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

// ---------------------------------------------------------------------
// Landing page and routing
// ---------------------------------------------------------------------
//
//   (no hash), #welcome, #tour   -> landing page
//   #search #explorer #lab #eval #review -> the app, on that tab
//   #app                          -> the app, on the current tab
//
// The app's data keeps loading in the background while the landing page
// is shown, so it is ready by the time someone clicks through.

const TAB_NAMES = ["search", "explorer", "lab", "eval", "review"];
const landingEl = document.getElementById("landing");
const appEl = document.getElementById("app");
const promoVideo = document.getElementById("promo-video");
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

if (promoVideo && reduceMotion) {
  promoVideo.removeAttribute("autoplay");
  promoVideo.pause();
}

function currentTab() {
  return document.querySelector(".tab.active")?.dataset.tab || "search";
}

function route() {
  const h = location.hash.slice(1);
  const toApp = TAB_NAMES.includes(h) || h === "app";
  const wasApp = !appEl.hidden;
  landingEl.hidden = toApp;
  appEl.hidden = !toApp;
  if (toApp) {
    promoVideo?.pause();
    activateTab(h === "app" ? currentTab() : h);
    if (!wasApp) window.scrollTo(0, 0);
  } else {
    if (promoVideo && !reduceMotion && promoVideo.paused) promoVideo.play().catch(() => {});
    if (h !== "tour" && wasApp) window.scrollTo(0, 0);
  }
}

window.addEventListener("hashchange", route);

// ---------------------------------------------------------------------
// Search tab
// ---------------------------------------------------------------------

const searchForm = document.getElementById("search-form");
const searchInput = document.getElementById("search-input");
const compareToggle = document.getElementById("compare-toggle");
const compareTarget = document.getElementById("compare-target");
const resultsEl = document.getElementById("results");
const traceEl = document.getElementById("query-trace");

const TOP_K = 10;

searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});

compareToggle.addEventListener("change", () => {
  if (searchInput.value.trim()) runSearch();
});

compareTarget.addEventListener("change", () => {
  compareToggle.checked = true;
  if (searchInput.value.trim()) runSearch();
});

function runSearch() {
  const query = searchInput.value.trim();
  resultsEl.innerHTML = "";
  traceEl.innerHTML = "";
  state.lastQuery = query;
  if (!query || !state.index) return;

  const stemmed = search(query, state.index, { topk: Infinity });

  if (!compareToggle.checked) {
    renderTrace(stemmed.trace, null);
    if (stemmed.results.length === 0) {
      resultsEl.innerHTML = `<p class="empty">No documents matched. Try a shorter or more common word, or turn on Compare to see the unstemmed baseline.</p>`;
      return;
    }
    resultsEl.innerHTML = stemmed.results
      .slice(0, TOP_K)
      .map((r) => renderResultCard(r, state.index, { compact: false }))
      .join("");
    return;
  }

  const target = compareTarget.value in CONFIGS ? compareTarget.value : "raw";
  const otherIndex = indexFor(target);
  const other = search(query, otherIndex, { topk: Infinity });
  renderTrace(stemmed.trace, other.trace, CONFIGS[target].termHeader);

  const stemmedIds = new Set(stemmed.results.map((r) => r.docId));
  const otherIds = new Set(other.results.map((r) => r.docId));
  const onlyStemmed = [...stemmedIds].filter((id) => !otherIds.has(id)).length;
  const onlyOther = [...otherIds].filter((id) => !stemmedIds.has(id)).length;
  const shared = stemmedIds.size - onlyStemmed;

  // Against raw search the story is "what stemming adds"; against
  // Snowball it is "which stemmer finds what".
  const vsRaw = target === "raw";
  const leftBadge = vsRaw ? { cls: "badge-gain", text: "found via stemming" } : { cls: "badge-gain", text: "only Xidid" };
  const rightBadge = vsRaw ? { cls: "badge-loss", text: "lost by stemming" } : { cls: "badge-loss", text: `only ${CONFIGS[target].label}` };

  const column = (title, run, index, idsOnOtherSide, badge, emptyMsg) => {
    const shown = run.results.slice(0, TOP_K);
    const more = run.results.length > TOP_K ? `<p class="col-more">Showing top ${TOP_K} of ${run.results.length}.</p>` : "";
    const body = shown.length
      ? shown
          .map((r) =>
            renderResultCard(r, index, {
              compact: true,
              badge: idsOnOtherSide.has(r.docId) ? null : badge,
              showVia: index !== state.rawIndex,
            })
          )
          .join("") + more
      : `<p class="empty">${emptyMsg}</p>`;
    return `
      <section class="compare-col">
        <h3 class="col-title">${title} <span class="col-count">${run.results.length} ${plural(run.results.length, "match", "matches")}</span></h3>
        ${body}
      </section>`;
  };

  const leftSummary = vsRaw ? `${onlyStemmed} found only via stemming` : `${onlyStemmed} only Xidid`;
  const rightSummary = vsRaw ? `${onlyOther} lost by stemming` : `${onlyOther} only ${CONFIGS[target].label}`;
  resultsEl.innerHTML = `
    <p class="compare-summary">
      <strong>Xidid</strong> ${stemmed.results.length} ·
      <strong>${CONFIGS[target].label}</strong> ${other.results.length} ·
      shared ${shared} ·
      <span class="badge badge-gain">${leftSummary}</span>
      ${onlyOther ? `<span class="badge badge-loss">${rightSummary}</span>` : ""}
    </p>
    <div class="compare-grid">
      ${column("Xidid", stemmed, state.index, otherIds, leftBadge, "No matches.")}
      ${column(
        vsRaw ? "Raw tokens" : CONFIGS[target].label,
        other,
        otherIndex,
        stemmedIds,
        rightBadge,
        vsRaw ? "No document contains this exact word form." : "No matches."
      )}
    </div>`;
}

function renderTrace(stemTrace, otherTrace, otherHeader = "Raw term") {
  const head = otherTrace
    ? `<tr><th>Token</th><th>Xidid term</th><th>${escapeHtml(otherHeader)}</th></tr>`
    : `<tr><th>Token</th><th>Stem</th></tr>`;
  const rows = stemTrace
    .map((t, i) => {
      const rawCell = otherTrace ? `<td>${escapeHtml(otherTrace[i]?.term || "\u2014")}</td>` : "";
      return `<tr><td>${escapeHtml(t.token)}</td><td>${escapeHtml(t.term || "\u2014")}</td>${rawCell}</tr>`;
    })
    .join("");
  traceEl.innerHTML = `<h3>How this query was read</h3><table class="trace-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

/**
 * One result card. In compact (side-by-side) mode the snippet is a
 * window around the first match instead of the whole text.
 * showVia: list the surface forms in this document that matched.
 */
function renderResultCard(r, index, { compact = false, badge = null, showVia = false } = {}) {
  const text = compact ? snippetWindow(r.text, r.matchedTerms, index.mapTerm) : r.text;
  const snippet = highlight(text, r.matchedTerms, index.mapTerm);
  const pct = Math.round(r.score * 100);
  let via = "";
  if (showVia) {
    const forms = matchedForms(r.docId, r.matchedTerms, index);
    if (forms.length) {
      via = `<p class="via">matched via ${forms
        .map((f) => `<button type="button" class="form-link" data-lab-word="${escapeHtml(f)}">${escapeHtml(f)}</button>`)
        .join(", ")}</p>`;
    }
  }
  return `
    <article class="result${compact ? " compact" : ""}">
      <div class="result-head">
        <h3>${escapeHtml(r.title)}</h3>
        <span class="score" title="cosine similarity">${r.score.toFixed(3)}</span>
      </div>
      <div class="score-bar"><span style="width:${Math.min(pct, 100)}%"></span></div>
      ${badge ? `<span class="badge ${badge.cls}">${badge.text}</span>` : ""}
      <p class="snippet">${snippet}</p>
      ${via}
      <p class="doc-id">${escapeHtml(r.docId)}</p>
      <details class="explain" data-doc-id="${escapeHtml(r.docId)}" data-score="${r.score}" data-which="${configOf(index)}">
        <summary>Why this result?</summary>
        <div class="explain-body"></div>
      </details>
    </article>`;
}

/** Surface forms in a document whose term is one of matchedTerms. */
function matchedForms(docId, matchedTerms, index) {
  const info = index.documents.get(docId);
  if (!info) return [];
  const want = new Set(matchedTerms);
  return [...info.originalToStem.entries()]
    .filter(([, term]) => want.has(term))
    .map(([form]) => form)
    .sort();
}

/** ~260 characters of text around the first matching word. */
function snippetWindow(text, matchedTerms, mapTerm, before = 80, after = 180) {
  if (text.length <= before + after) return text;
  const want = new Set(matchedTerms);
  let pos = 0;
  for (const m of text.matchAll(/[\p{L}]+/gu)) {
    if (want.has(mapTerm(m[0]))) {
      pos = m.index;
      break;
    }
  }
  let start = Math.max(0, pos - before);
  let end = Math.min(text.length, pos + after);
  if (start > 0) start = text.indexOf(" ", start) + 1 || start;
  if (end < text.length) end = text.lastIndexOf(" ", end) > pos ? text.lastIndexOf(" ", end) : end;
  return (start > 0 ? "\u2026" : "") + text.slice(start, end).trim() + (end < text.length ? "\u2026" : "");
}

// "Why this result?" panels are filled in when first opened. The toggle
// event doesn't bubble, so listen in the capture phase.
resultsEl.addEventListener(
  "toggle",
  (e) => {
    const details = e.target;
    if (!details.matches?.("details.explain") || !details.open) return;
    const body = details.querySelector(".explain-body");
    if (body.dataset.filled) return;
    const index = indexFor(details.dataset.which) || state.index;
    body.innerHTML = renderExplanation(
      explain(state.lastQuery, details.dataset.docId, index),
      details.dataset.which,
      Number(details.dataset.score)
    );
    body.dataset.filled = "1";
  },
  true
);

const STATUS_TEXT = {
  "not-in-doc": "not in this document",
  "not-in-index": "not in the index (df = 0)",
  "every-doc": "in every document (idf = 0)",
};

const STATUS_REASON = {
  "not-in-doc": "it does not occur in this document",
  "not-in-index": "no document in the corpus contains it",
  "every-doc": "it occurs in every document, so its idf is 0",
};

function renderExplanation(ex, which, shownScore) {
  if (!ex) return `<p class="empty">Couldn't explain this result.</p>`;
  const f4 = (n) => n.toFixed(4);
  const termLabel = which === "raw" ? "Query token" : "Query term";
  const matched = ex.rows.filter((r) => r.status === "matched").sort((a, b) => b.share - a.share);
  const tableRows = ex.rows
    .slice()
    .sort((a, b) => b.contribution - a.contribution)
    .map((r) => {
      const muted = r.status !== "matched";
      const forms = muted
        ? `<span class="status">${STATUS_TEXT[r.status]}</span>`
        : r.forms.map((f) => `${escapeHtml(f.form)}${f.count > 1 ? ` \u00d7${f.count}` : ""}`).join(", ");
      return `
        <tr class="${muted ? "row-muted" : ""}">
          <td><code>${escapeHtml(r.term)}</code></td>
          <td>${forms}</td>
          <td>${r.count} / ${r.docLength}</td>
          <td>${r.df}</td>
          <td>${r.idf.toFixed(3)}</td>
          <td>${f4(r.docWeight)}</td>
          <td>${f4(r.queryWeight)}</td>
          <td>${f4(r.contribution)}</td>
          <td><span class="share"><span class="mini-bar"><span style="width:${(r.share * 100).toFixed(1)}%"></span></span>${Math.round(
            r.share * 100
          )}%</span></td>
        </tr>`;
    })
    .join("");

  // The ranking's score (shown on the card) vs the sum of the table's rows.
  const adds = Math.abs(ex.score - shownScore) < 1e-4;
  return `
    <p class="explain-lead">${explanationLead(ex, matched)}</p>
    <div class="table-scroll">
      <table class="trace-table explain-table">
        <thead>
          <tr>
            <th>${termLabel}</th><th>Forms in this doc</th><th title="occurrences / indexed words in document">Count</th>
            <th title="documents containing the term">df</th><th title="ln(N / df)">idf</th>
            <th title="(count / length) \u00d7 idf">Doc weight</th><th title="(query count / query length) \u00d7 idf">Query weight</th>
            <th title="doc weight \u00d7 query weight / (\u2016d\u2016 \u00d7 \u2016q\u2016)">Contribution</th><th>Share</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
        <tfoot>
          <tr><td colspan="7">Score = sum of contributions</td><td>${f4(ex.score)}</td><td>100%</td></tr>
        </tfoot>
      </table>
    </div>
    <p class="explain-norms">
      N = ${ex.docCount} documents \u00b7 document length = ${ex.docLength} indexed words, ${ex.distinctDocTerms} distinct terms \u00b7
      \u2016d\u2016 = ${f4(ex.docNorm)} \u00b7 \u2016q\u2016 = ${f4(ex.queryNorm)}
    </p>
    <p class="explain-formula">cos(q, d) = \u03a3 w<sub>q,t</sub> \u00b7 w<sub>d,t</sub> / (\u2016q\u2016 \u00b7 \u2016d\u2016), where w<sub>x,t</sub> = (count of t in x / length of x) \u00b7 ln(N / df<sub>t</sub>)</p>
    <p class="explain-check ${adds ? "ok" : "bad"}">${
      adds
        ? `\u2713 The contributions add up to the displayed score (${f4(ex.score)}).`
        : `\u26a0 The contributions (${f4(ex.score)}) do not match the displayed score (${f4(shownScore)}). The index may have changed since this search; search again.`
    }</p>`;
}

/** One or two plain-language sentences summarising the table. */
function explanationLead(ex, matched) {
  const q = (t) => `<code>${escapeHtml(t)}</code>`;
  const missing = ex.rows.filter((r) => r.status !== "matched");
  const missingNote = missing.length
    ? " " + missing.map((r) => `${q(r.term)} adds nothing: ${STATUS_REASON[r.status]}.`).join(" ")
    : "";
  if (matched.length === 0) return `No query term matched this document.${missingNote}`;
  const top = matched[0];
  const formNote = top.forms.length && !(top.forms.length === 1 && top.forms[0].form === top.term)
    ? ` (written ${top.forms.map((f) => `<em>${escapeHtml(f.form)}</em>`).join(", ")} here)`
    : "";
  const rarity = `it occurs in ${top.df} of ${ex.docCount} documents (idf ${top.idf.toFixed(2)})`;
  if (matched.length === 1) {
    return `All of this score comes from ${q(top.term)}${formNote}: ${rarity}, and makes up ${top.count} of this document's ${
      ex.docLength
    } indexed words.${missingNote}`;
  }
  const second = matched[1];
  const why =
    top.idf > second.idf
      ? `it is rarer than ${q(second.term)} (${top.df} vs ${second.df} documents), and rarer terms weigh more`
      : `it occurs more often in this document (${top.count} vs ${second.count} times)`;
  return `${q(top.term)}${formNote} carries ${Math.round(top.share * 100)}% of the score: ${why}.${missingNote}`;
}

// Any "matched via" form button opens that word in the Stemmer Lab.
resultsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-lab-word]");
  if (btn) openInLab(btn.dataset.labWord);
});

function renderCorpusStats() {
  const el = document.getElementById("corpus-stats");
  if (!state.index) return;
  el.textContent = `${state.documents.length} documents indexed · ${state.index.postings.size} distinct stems in the vocabulary`;
}

function renderCorpusList() {
  const el = document.getElementById("corpus-list");
  el.innerHTML = state.documents
    .map(
      (d) => `
      <li>
        <span class="doc-title">${escapeHtml(d.title)}</span>
        <button type="button" class="link-btn" data-remove-doc="${escapeHtml(d.id)}">Remove</button>
      </li>`
    )
    .join("");
  el.querySelectorAll("[data-remove-doc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.removeDoc;
      state.documents = state.documents.filter((d) => d.id !== id);
      rebuildIrIndex();
    });
  });
}

document.getElementById("reset-corpus").addEventListener("click", () => {
  state.documents = state.defaultDocuments.map((d) => ({ ...d }));
  rebuildIrIndex();
});

document.getElementById("add-doc-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const title = document.getElementById("doc-title").value.trim();
  const text = document.getElementById("doc-text").value.trim();
  if (!title || !text) return;
  const id = `custom-${Date.now()}`;
  state.documents.push({ id, title, text });
  rebuildIrIndex();
  e.target.reset();
});

document.getElementById("download-corpus")?.addEventListener("click", () => {
  downloadJson("corpus.json", state.documents);
});

document.getElementById("import-corpus")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error("expected a JSON array of {id, title, text}");
    const bad = data.findIndex((d) => !d || typeof d.text !== "string" || !d.text.trim());
    if (bad !== -1) throw new Error(`document #${bad + 1} has no text`);
    const seen = new Set();
    state.documents = data.map((d, i) => {
      let id = d.id ? String(d.id) : `imported-${i + 1}`;
      if (seen.has(id)) id = `${id}-${i + 1}`;
      seen.add(id);
      return { ...d, id, title: d.title ? String(d.title) : `Document ${i + 1}` };
    });
    rebuildIrIndex();
  } catch (err) {
    alert(`Couldn't import corpus.json: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------------------------------------------------------------------
// Stemmer Lab tab
// ---------------------------------------------------------------------

const labForm = document.getElementById("lab-form");
const labInput = document.getElementById("lab-input");
const labResults = document.getElementById("lab-results");

labForm.addEventListener("submit", (e) => {
  e.preventDefault();
  renderLab();
});

function renderLab() {
  const words = labInput.value.trim().split(/\s+/).filter(Boolean);
  labResults.innerHTML = words.map((w) => renderStemCard(w)).join("");
}

/** Jump to the Stemmer Lab with one word's trace showing. */
function openInLab(word) {
  labInput.value = word;
  renderLab();
  activateTab("lab");
  labResults.scrollIntoView({ behavior: "smooth", block: "start" });
}

const METHOD_LABELS = {
  direct: "confirmed directly against the lexicon",
  "vowel-repair": "confirmed after a vowel-alternation repair (e.g. hooya \u2192 hooyo)",
  blind: "no lexicon loaded \u2014 blind longest-suffix match",
};

function describeMethod(method) {
  if (!method) return null;
  if (method.startsWith("ngram-fallback")) {
    return `not confirmed directly \u2014 accepted via n-gram nearest-neighbor fallback (${method.slice(15)})`;
  }
  return METHOD_LABELS[method] || method;
}

function renderStemCard(word) {
    const trace = stemVerbose(word, stemOpts({ useNgram: true }));
  const rows = [];
  rows.push(["normalized", trace.normalized]);
  if (trace.reason === "override") rows.push(["matched override", `\u2192 ${trace.result}`]);
  if (trace.reason === "protected") rows.push(["protected word", "kept as-is"]);
  if (trace.reason === "too-short") rows.push(["too short to strip", `\u2264 min stem length`]);
  if (trace.withoutPrefix !== undefined) {
    rows.push(["suffix-stripped candidate", trace.withoutPrefix]);
    if (trace.withPrefix !== null && trace.withPrefix !== undefined) {
      rows.push(["prefix + suffix-stripped candidate", trace.withPrefix]);
    }
  }
  const methodLabel = describeMethod(trace.method);
  if (methodLabel) rows.push(["how it was confirmed", methodLabel]);

  // trace.method is set whenever stemVerbose() confirmed the result itself
  // (direct / vowel-repair / ngram-fallback). If it's still null, nothing
  // confirmed it -- show the nearest lexicon word anyway as an FYI, even
  // though it didn't clear the fallback's similarity/length bar.
  let suggestion = "";
  const notConfirmed = trace.lexiconActive && !trace.method && !isLikelyConfirmed(trace);
  if (notConfirmed && state.ngramIndex) {
    const near = ngramRank(trace.result, state.ngramIndex, undefined, 1);
    if (near.length) {
      suggestion = `<p class="hint">Not confirmed by the lexicon (below the fallback's similarity threshold). Closest known word: <strong>${escapeHtml(
        near[0][0]
      )}</strong> (similarity ${near[0][1].toFixed(2)})</p>`;
    }
  }

  return `
    <article class="stem-card">
      <div class="stem-headline">
        <span class="orig">${escapeHtml(word)}</span>
        <span class="arrow">\u2192</span>
        <span class="result">${escapeHtml(trace.result)}</span>
      </div>
      <table class="trace-table">
        <tbody>
          ${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join("")}
        </tbody>
      </table>
      ${suggestion}
      ${snowballLine(word, trace.result)}
    </article>`;
}

/** What the rules-only Snowball stemmer makes of the same word. */
function snowballLine(word, xididResult) {
  const key = normalize(word);
  if (!key) return "";
  const sb = snowballStemmer.stemWord(key);
  const same = sb === xididResult;
  return `<p class="snowball-line">Snowball stemmer: <code>${escapeHtml(sb)}</code> ${
    same ? "(same as Xidid)" : "(differs from Xidid; no dictionary, no prefix stripping)"
  }</p>`;
}

function isLikelyConfirmed(trace) {
  if (trace.reason === "override" || trace.reason === "protected" || trace.reason === "too-short") return true;
  return state.protected.has(trace.result) || state.lexicon.has(trace.result);
}

// ---------------------------------------------------------------------
// Protected words management
// ---------------------------------------------------------------------

function renderProtectedList() {
  const el = document.getElementById("protected-list");
  const words = [...state.protected].sort();
  el.innerHTML = words.length
    ? words
        .map(
          (w) =>
            `<li>${escapeHtml(w)} <button type="button" class="link-btn" data-remove-protected="${escapeHtml(w)}">remove</button></li>`
        )
        .join("")
    : `<li class="empty">None yet.</li>`;
  el.querySelectorAll("[data-remove-protected]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.protected.delete(btn.dataset.removeProtected);
      renderProtectedList();
      onStemmerConfigChanged();
    });
  });
}

document.getElementById("protected-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("protected-input");
  const words = input.value.trim().split(/[\s,]+/).filter(Boolean);
  for (const w of words) {
    const n = normalize(w);
    if (n) state.protected.add(n);
  }
  input.value = "";
  renderProtectedList();
  onStemmerConfigChanged();
});

document.getElementById("download-protected").addEventListener("click", () => {
  downloadJson("protected_words.json", [...state.protected].sort());
});

document.getElementById("import-protected")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error("expected a JSON array of words");
    state.protected = new Set(data.map(normalize).filter(Boolean));
    renderProtectedList();
    onStemmerConfigChanged();
  } catch (err) {
    alert(`Couldn't import protected_words.json: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------------------------------------------------------------------
// Overrides management
// ---------------------------------------------------------------------

function renderOverridesList() {
  const el = document.getElementById("overrides-list");
  const pairs = [...state.overrides.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  el.innerHTML = pairs.length
    ? pairs
        .map(
          ([w, t]) =>
            `<li>${escapeHtml(w)} \u2192 ${escapeHtml(t)} <button type="button" class="link-btn" data-remove-override="${escapeHtml(w)}">remove</button></li>`
        )
        .join("")
    : `<li class="empty">None yet.</li>`;
  el.querySelectorAll("[data-remove-override]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.overrides.delete(btn.dataset.removeOverride);
      renderOverridesList();
      onStemmerConfigChanged();
    });
  });
}

document.getElementById("overrides-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("overrides-input");
  const pairs = input.value.trim().split(/[\s,]+/).filter(Boolean);
  for (const pair of pairs) {
    const [w, t] = pair.split("=");
    if (w && t) {
      const nw = normalize(w);
      const nt = normalize(t);
      if (nw && nt) state.overrides.set(nw, nt);
    }
  }
  input.value = "";
  renderOverridesList();
  onStemmerConfigChanged();
});

document.getElementById("download-overrides").addEventListener("click", () => {
  const obj = Object.fromEntries([...state.overrides.entries()].sort());
  downloadJson("stem_overrides.json", obj);
});

document.getElementById("import-overrides")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (typeof data !== "object" || Array.isArray(data) || data === null) {
      throw new Error("expected a JSON object of word: stem pairs");
    }
    state.overrides = new Map(
      Object.entries(data)
        .map(([k, v]) => [normalize(k), normalize(v)])
        .filter(([k, v]) => k && v)
    );
    renderOverridesList();
    onStemmerConfigChanged();
  } catch (err) {
    alert(`Couldn't import stem_overrides.json: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

// ---------------------------------------------------------------------
// Conflation tab
// ---------------------------------------------------------------------

const figuresEl = document.getElementById("corpus-figures");
const explorerForm = document.getElementById("explorer-form");
const explorerInput = document.getElementById("explorer-input");
const explorerResult = document.getElementById("explorer-result");
const largestEl = document.getElementById("largest-classes");

explorerForm.addEventListener("submit", (e) => {
  e.preventDefault();
  renderLookup(explorerInput.value);
});

document.getElementById("tab-explorer").addEventListener("click", (e) => {
  const lookup = e.target.closest("[data-lookup], [data-lookup-term]");
  if (lookup) {
    const exactTerm = lookup.hasAttribute("data-lookup-term");
    const value = exactTerm ? lookup.dataset.lookupTerm : lookup.dataset.lookup;
    explorerInput.value = value;
    renderLookup(value, { exactTerm });
    explorerResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const lab = e.target.closest("[data-lab-word]");
  if (lab) {
    openInLab(lab.dataset.labWord);
    return;
  }
  const searchBtn = e.target.closest("[data-compare-query]");
  if (searchBtn) {
    searchInput.value = searchBtn.dataset.compareQuery;
    compareToggle.checked = true;
    compareTarget.value = state.confView === "snowball" ? "snowball" : "raw";
    activateTab("search");
    runSearch();
  }
});

document.querySelectorAll("[data-conf]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.confView = btn.dataset.conf;
    document.querySelectorAll("[data-conf]").forEach((b) => b.classList.toggle("active", b === btn));
    state.conflation = state.conflations[state.confView];
    renderExplorer();
  });
});

function renderExplorer() {
  if (!state.conflation) return;
  const s = state.conflation.stats;
  const fmt = (n) => n.toLocaleString("en-US");
  const figures = [
    [fmt(s.documents), "documents"],
    [fmt(s.tokens), "word tokens indexed"],
    [fmt(s.forms), "distinct word forms"],
    [fmt(s.terms), "distinct stems"],
    [`${(s.reduction * 100).toFixed(1)}%`, "vocabulary reduction"],
    [fmt(s.mergedClasses), "stems that merged 2+ forms"],
  ];
  // Non-idempotent terms: stemming the stem again gives something else.
  const confMap = indexFor(state.confView).mapTerm;
  state.unstable = unstableTerms(state.conflation, confMap);
  figuresEl.innerHTML = figures.map(([v, label]) => `<div><dt>${label}</dt><dd>${v}</dd></div>`).join("");

  // One-line comparison of the two stemmers, whichever is shown.
  const x = state.conflations.stemmed.stats;
  const sb = state.conflations.snowball.stats;
  document.getElementById("conf-compare").innerHTML = `Xidid: ${fmt(x.terms)} stems (${(x.reduction * 100).toFixed(
    1
  )}% reduction) \u00b7 Snowball: ${fmt(sb.terms)} stems (${(sb.reduction * 100).toFixed(1)}% reduction).
    Snowball merges more because it has no dictionary to veto a cut; some of those merges are right, some are not.`;

  const top = largestClasses(state.conflation, 15);
  const maxForms = top.length ? top[0].forms.size : 1;
  largestEl.innerHTML = top
    .map((cls) => {
      const forms = sortedForms(cls);
      const preview = forms.slice(0, 6).map((f) => escapeHtml(f.form)).join(", ") + (forms.length > 6 ? ", \u2026" : "");
      return `
        <li>
          <button type="button" class="class-row" data-lookup-term="${escapeHtml(cls.term)}">
            <span class="class-term">${escapeHtml(cls.term)}</span>
            <span class="class-bar"><span style="width:${((cls.forms.size / maxForms) * 100).toFixed(1)}%"></span></span>
            <span class="class-n">${cls.forms.size} forms</span>
            <span class="class-preview">${preview}</span>
          </button>
        </li>`;
    })
    .join("");

  const unstableEl = document.getElementById("unstable-note");
  // Two illustrative unstable terms: the ones with the largest classes.
  const pick = state.unstable
    .map((u) => u.term)
    .sort((a, b) => state.conflation.classes.get(b).forms.size - state.conflation.classes.get(a).forms.size || a.localeCompare(b))
    .slice(0, 2);
  unstableEl.innerHTML = state.unstable.length
    ? `<strong>${fmt(state.unstable.length)} index terms are unstable:</strong> stemming the term again gives a different term,
       so related forms can end up split across two classes${
         pick.length
           ? ` (try ${pick.map((t) => `<button type="button" class="chip" data-lookup="${t}">${t}</button>`).join(" ")})`
           : ""
       }.`
    : "";

  // Keep an open lookup in sync after the index is rebuilt.
  if (explorerInput.value.trim()) renderLookup(explorerInput.value);
}

function renderLookup(input, { exactTerm = false } = {}) {
  if (!state.conflation || !input.trim()) {
    explorerResult.innerHTML = "";
    return;
  }
  const found = lookupClass(state.conflation, input, indexFor(state.confView).mapTerm, { exactTerm });
  if (!found) return;

  const alsoNote = found.also
    ? `<p class="warn-note"><strong>Inconsistent conflation.</strong> <code>${escapeHtml(found.input)}</code> is itself
       stemmed to <code>${escapeHtml(found.term)}</code>, but ${found.also.cls.forms.size}
       ${plural(found.also.cls.forms.size, "other form", "other forms")}
       (${sortedForms(found.also.cls).map((f) => escapeHtml(f.form)).join(", ")}) are indexed under
       <code>${escapeHtml(found.also.term)}</code>. A search for <code>${escapeHtml(found.input)}</code> will not find them.
       <button type="button" class="link-btn" data-lookup-term="${escapeHtml(found.also.term)}">Show that class</button></p>`
    : "";

  const mapping = found.viaMapping
    ? `<p class="lookup-mapping"><code>${escapeHtml(found.input)}</code> is indexed as <code>${escapeHtml(
        found.term || "\u2014"
      )}</code></p>`
    : "";

  if (!found.cls) {
    explorerResult.innerHTML = `${mapping}${alsoNote}<p class="empty">The term <code>${escapeHtml(
      found.term || found.input
    )}</code> does not occur in this corpus.</p>`;
    return;
  }

  const { cls } = found;
  const forms = sortedForms(cls);
  const maxCount = forms[0].count;
  explorerResult.innerHTML = `
    ${mapping}
    ${alsoNote}
    <div class="class-card">
      <div class="class-card-head">
        <h3><code>${escapeHtml(cls.term)}</code></h3>
        <p>${forms.length} ${plural(forms.length, "form", "forms")} · ${cls.count} ${plural(cls.count, "occurrence", "occurrences")} · ${cls.docs.size} ${plural(cls.docs.size, "document", "documents")}</p>
        <button type="button" class="secondary small" data-compare-query="${escapeHtml(cls.term)}">Compare in Search</button>
      </div>
      <table class="trace-table forms-table">
        <thead><tr><th>Word form</th><th>Occurrences</th><th>Documents</th><th></th></tr></thead>
        <tbody>
          ${forms
            .map(
              (f) => `
            <tr>
              <td><button type="button" class="form-link" data-lab-word="${escapeHtml(f.form)}" title="Open in Stemmer Lab">${escapeHtml(f.form)}</button></td>
              <td><span class="mini-bar"><span style="width:${((f.count / maxCount) * 100).toFixed(1)}%"></span></span>${f.count}</td>
              <td>${f.docs}</td>
              <td><button type="button" class="link-btn" data-lab-word="${escapeHtml(f.form)}">trace</button></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <p class="hint">${
        forms.length === 1
          ? "Only one form of this term occurs in the corpus, so stemming adds nothing here."
          : "If these forms don't all mean related things, the stemmer has overstemmed. Click a form to see the rule that produced it."
      }</p>
    </div>`;
}

// ---------------------------------------------------------------------
// Evaluation tab
// ---------------------------------------------------------------------
//
// Judgments live in state.qrels. They're saved to localStorage on every
// change (this app runs from a local server, so browser storage is
// available), and can be downloaded as data/qrels.json to keep with the
// project. Metrics are recomputed from scratch whenever judgments or the
// index change, so the numbers always reflect the current stemmer.

const QRELS_STORAGE_KEY = "xidid.qrels.v1";

const evalBanner = document.getElementById("eval-banner");
const evalResultsEl = document.getElementById("eval-results");
const evalJudgeEl = document.getElementById("eval-judge");
const evalProgressEl = document.getElementById("eval-progress");
const evalTab = document.getElementById("tab-eval");

function emptyQrels() {
  return { version: 1, poolDepth: DEFAULT_POOL_DEPTH, judge: "", notes: "", queries: [] };
}

function loadSavedQrels() {
  try {
    const raw = localStorage.getItem(QRELS_STORAGE_KEY);
    return raw ? validateQrels(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveQrels() {
  try {
    localStorage.setItem(QRELS_STORAGE_KEY, JSON.stringify(state.qrels));
  } catch {
    // Storage unavailable (private mode etc.): judgments still work for
    // this session; Download qrels.json is the way to keep them.
  }
}

function isEvalActive() {
  return evalTab.classList.contains("active");
}

function onEvalDataChanged() {
  state.evaluation = null; // recomputed lazily
  if (isEvalActive()) renderEval();
  else renderEvalProgress();
}

function getEvaluation() {
  if (!state.evaluation && state.index && state.qrels) {
    state.evaluation = evaluate(
      state.qrels,
      { raw: state.rawIndex, stemmed: state.index, snowball: state.snowballIndex },
      new Set(state.documents.map((d) => d.id))
    );
  }
  return state.evaluation;
}

function renderEvalProgress() {
  const ev = getEvaluation();
  if (!ev) return;
  evalProgressEl.textContent = `${ev.completeCount} of ${ev.totalQueries} queries fully judged`;
}

function renderEval() {
  const ev = getEvaluation();
  if (!ev) return;
  renderEvalProgress();

  const banners = [];
  if (/synthetic/i.test(state.qrels.judge || "")) {
    banners.push(`<p class="warn-note"><strong>Synthetic judgments loaded.</strong> These were generated by a keyword rule
      to test the dashboard. They are not real relevance judgments and are biased towards stemming by construction.
      Do not present these numbers. Use <em>Reset to data/qrels.json</em> to go back to your own judgments.</p>`);
  }
  if (state.qrelsSource === "browser") {
    banners.push(`<p class="note">Showing judgments saved in this browser. <em>Reset to data/qrels.json</em> reloads the project file instead.</p>`);
  }
  if (ev.warnings.length) {
    banners.push(`<div class="warn-note"><strong>Problems in qrels.json:</strong><ul>${ev.warnings
      .map((w) => `<li>${escapeHtml(w)}</li>`)
      .join("")}</ul></div>`);
  }
  evalBanner.innerHTML = banners.join("");

  if (state.evalView === "judge") renderJudge(ev);
  else renderResults(ev);
}

// --- view switch ---

evalTab.querySelectorAll("[data-eval-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.evalView = btn.dataset.evalView;
    evalTab.querySelectorAll("[data-eval-view]").forEach((b) => b.classList.toggle("active", b === btn));
    evalResultsEl.hidden = state.evalView !== "results";
    evalJudgeEl.hidden = state.evalView !== "judge";
    renderEval();
  });
});

function showEvalView(view) {
  evalTab.querySelector(`[data-eval-view="${view}"]`).click();
}

// --- results dashboard ---

// Which two configurations the "helped / hurt" chart and the per-query
// Difference column compare: [better-if-positive, baseline].
const EVAL_PAIRS = {
  "stemmed-raw": ["stemmed", "raw"],
  "snowball-raw": ["snowball", "raw"],
  "snowball-stemmed": ["snowball", "stemmed"],
};
const EVAL_CONFIGS = ["raw", "stemmed", "snowball"];

function renderResults(ev) {
  const complete = ev.perQuery.filter((r) => r.complete);
  if (complete.length === 0) {
    evalResultsEl.innerHTML = `
      <div class="eval-empty">
        <p>No query has been fully judged yet, so there is nothing to measure.</p>
        <p><button type="button" data-goto-judge>Start judging</button></p>
        <p class="note">To try the dashboard first, import <code>data/qrels.sample-synthetic.json</code>
          (keyword-generated, for testing only).</p>
      </div>`;
    return;
  }

  const s = ev.summary;
  const [pos, base] = EVAL_PAIRS[state.evalPair] || EVAL_PAIRS["stemmed-raw"];
  const metrics = [
    ["P@5", "p5", "share of the top 5 results that are relevant"],
    ["P@10", "p10", "share of the top 10 results that are relevant"],
    ["Recall@10", "r10", "share of all known relevant documents found in the top 10"],
    ["MAP", "map", "mean average precision: rewards ranking relevant documents early"],
  ];
  const f3 = (v) => (v === null ? "\u2014" : v.toFixed(3));

  const summaryRows = metrics
    .map(([label, key, help]) => {
      const vals = EVAL_CONFIGS.map((c) => s[c][key]);
      const best = Math.max(...vals.filter((v) => v !== null));
      return `
      <tr>
        <td title="${escapeHtml(help)}">${label}</td>
        ${vals.map((v) => `<td class="${v !== null && v === best ? "best" : ""}">${f3(v)}</td>`).join("")}
      </tr>`;
    })
    .join("");

  const diffRows = complete
    .filter((r) => r.relevantCount > 0)
    .map((r) => ({ id: r.id, text: r.text, delta: r.byConfig[pos].ap - r.byConfig[base].ap }))
    .sort((a, b) => b.delta - a.delta);

  const queryRows = ev.perQuery
    .map((r) => {
      const ap = (c) => (r.complete && r.byConfig[c].ap !== null ? r.byConfig[c].ap.toFixed(3) : "\u2014");
      const d = r.complete && r.relevantCount > 0 ? r.byConfig[pos].ap - r.byConfig[base].ap : null;
      return `
        <tr class="${r.complete ? "" : "row-muted"}" data-query="${escapeHtml(r.text)}" tabindex="0">
          <td><code>${escapeHtml(r.text)}</code><span class="gloss">${escapeHtml(r.gloss)}</span></td>
          <td>${r.judgedCount}/${r.poolSize}${r.unsureCount ? ` <span class="unsure-count" title="marked unsure">(${r.unsureCount}?)</span>` : ""}</td>
          <td>${r.complete ? r.relevantCount : "\u2014"}</td>
          ${EVAL_CONFIGS.map((c) => `<td>${ap(c)}</td>`).join("")}
          <td class="${d === null ? "" : d >= 0 ? "pos" : "neg"}">${d === null ? (r.complete ? "no relevant" : "not judged") : `${d >= 0 ? "+" : ""}${d.toFixed(3)}`}</td>
        </tr>`;
    })
    .join("");

  const totalUnsure = ev.perQuery.reduce((n, r) => n + r.unsureCount, 0);
  const pairOptions = Object.entries(EVAL_PAIRS)
    .map(
      ([key, [a, b]]) =>
        `<option value="${key}" ${key === state.evalPair ? "selected" : ""}>${CONFIGS[a].label} vs ${CONFIGS[b].label}</option>`
    )
    .join("");

  evalResultsEl.innerHTML = `
    <h2 class="section-title">Average over ${complete.length} judged ${plural(complete.length, "query", "queries")}</h2>
    <p class="note">Recall and MAP average over the ${ev.withRelevantCount} ${plural(
    ev.withRelevantCount,
    "query",
    "queries"
  )} with at least one relevant document. The best value in each row is highlighted.</p>
    <div class="eval-summary">
      <table class="trace-table metric-table">
        <thead><tr><th>Metric</th>${EVAL_CONFIGS.map((c) => `<th>${CONFIGS[c].label}</th>`).join("")}</tr></thead>
        <tbody>${summaryRows}</tbody>
      </table>
      <figure class="chart" data-chart="bars"></figure>
    </div>

    <h2 class="section-title">Where one configuration beats another</h2>
    <div class="pair-row">
      <label for="eval-pair">Compare</label>
      <select id="eval-pair">${pairOptions}</select>
    </div>
    <p class="note">Average precision per query, ${CONFIGS[pos].label} minus ${CONFIGS[base].label}. Click a bar to see that query side by side.</p>
    <figure class="chart" data-chart="diverging"></figure>

    <h2 class="section-title">Precision at each rank</h2>
    <p class="note">Of the results at ranks 1 to k, how many are relevant, averaged over judged queries.</p>
    <figure class="chart" data-chart="ranks"></figure>

    <h2 class="section-title">Per query</h2>
    <div class="table-scroll">
      <table class="trace-table query-table">
        <thead><tr><th>Query</th><th>Judged</th><th>Relevant</th>${EVAL_CONFIGS.map((c) => `<th>AP ${CONFIGS[c].label}</th>`).join(
          ""
        )}<th>${CONFIGS[pos].label} \u2212 ${CONFIGS[base].label}</th></tr></thead>
        <tbody>${queryRows}</tbody>
      </table>
    </div>

    <details class="limitations">
      <summary>Limitations of this evaluation</summary>
      <ul>
        <li>${ev.totalQueries} queries, one judge${state.qrels.judge ? ` (${escapeHtml(state.qrels.judge)})` : ""}, binary relevance: indicative, not statistically significant.</li>
        <li>Relevance was judged through machine translation by a non-Somali speaker${totalUnsure ? `; ${totalUnsure} ${plural(totalUnsure, "judgment was", "judgments were")} marked unsure` : ""}.</li>
        <li>Pooling: only the top ${state.qrels.poolDepth} of each configuration were judged. Relevant documents that none found are unknown, so recall is relative.</li>
        <li>Queries were chosen to include known stemmer problems, so this is a diagnostic set, not a random sample of real searches.</li>
        <li>The Snowball stemmer is an unreviewed prototype (Phase 4a); its numbers say how the rules-only approach does on this corpus, not how a finished Snowball stemmer would.</li>
      </ul>
    </details>`;

  evalResultsEl.querySelector("#eval-pair").addEventListener("change", (e) => {
    state.evalPair = e.target.value;
    renderEval();
  });
  drawCharts(s, diffRows, pos, base);
}

function drawCharts(summary, diffRows, pos, base) {
  const width = (el) => Math.max(280, Math.floor(el.clientWidth));
  const bars = evalResultsEl.querySelector('[data-chart="bars"]');
  const div = evalResultsEl.querySelector('[data-chart="diverging"]');
  const ranks = evalResultsEl.querySelector('[data-chart="ranks"]');
  const labels = Object.fromEntries(EVAL_CONFIGS.map((c) => [c, CONFIGS[c].label]));
  const group = (label, key) => ({ label, values: Object.fromEntries(EVAL_CONFIGS.map((c) => [c, summary[c][key]])) });
  if (bars) {
    bars.innerHTML = groupedBarChart([group("P@5", "p5"), group("P@10", "p10"), group("R@10", "r10"), group("MAP", "map")], {
      width: width(bars),
      configs: EVAL_CONFIGS,
      labels,
    });
  }
  if (div) {
    const vsRaw = base === "raw";
    div.innerHTML = diffRows.length
      ? divergingBarChart(diffRows, {
          width: width(div),
          posLabel: vsRaw ? `${CONFIGS[pos].label} stemming helped` : `${CONFIGS[pos].label} better`,
          negLabel: vsRaw ? `${CONFIGS[pos].label} stemming hurt` : `${CONFIGS[base].label} better`,
          shortPos: vsRaw ? "helped" : CONFIGS[pos].label,
          shortNeg: vsRaw ? "hurt" : CONFIGS[base].label,
        })
      : `<p class="empty">No judged query has a relevant document yet.</p>`;
  }
  if (ranks) {
    ranks.innerHTML = precisionAtRankChart(Object.fromEntries(EVAL_CONFIGS.map((c) => [c, summary[c].pAtRank])), {
      width: width(ranks),
      labels,
    });
  }
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (isEvalActive() && state.evalView === "results") renderEval();
  }, 150);
});

function compareQuery(text) {
  searchInput.value = text;
  compareToggle.checked = true;
  // Xidid is always the left column; show whichever other configuration
  // the current pair involves (Snowball if it's in the pair, else Raw).
  compareTarget.value = (EVAL_PAIRS[state.evalPair] || []).includes("snowball") ? "snowball" : "raw";
  activateTab("search");
  runSearch();
}

evalResultsEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-goto-judge]")) return showEvalView("judge");
  const row = e.target.closest("[data-query]");
  if (row) compareQuery(row.dataset.query);
});

evalResultsEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest("[data-query]");
  if (row) {
    e.preventDefault();
    compareQuery(row.dataset.query);
  }
});

// --- judging view ---

function renderJudge(ev) {
  if (!state.qrels.queries.length) {
    evalJudgeEl.innerHTML = `<p class="empty">No queries in qrels.json.</p>`;
    return;
  }
  const qi = Math.min(state.judgeQuery, state.qrels.queries.length - 1);
  const q = state.qrels.queries[qi];
  const row = ev.perQuery[qi];
  const pool = buildPool(q.text, [state.rawIndex, state.index, state.snowballIndex], state.qrels.poolDepth);
  const byId = new Map(state.documents.map((d) => [d.id, d]));

  const chips = state.qrels.queries
    .map((qq, i) => {
      const r = ev.perQuery[i];
      return `<button type="button" class="chip judge-chip ${i === qi ? "current" : ""} ${r.complete ? "done" : ""}" data-judge-query="${i}">
        ${escapeHtml(qq.text)} <span>${r.judgedCount}/${r.poolSize}</span></button>`;
    })
    .join("");

  const docs = pool
    .map((id, n) => {
      const d = byId.get(id);
      if (!d) return "";
      const j = q.judgments[id];
      const translate = `https://translate.google.com/?sl=so&tl=en&op=translate&text=${encodeURIComponent(`${d.title}\n\n${d.text}`)}`;
      return `
        <article class="judge-doc ${j ? (j.rel ? "is-rel" : "is-nonrel") : ""}">
          <div class="judge-head">
            <span class="judge-n">${n + 1}/${pool.length}</span>
            <h3>${escapeHtml(d.title)}</h3>
          </div>
          <p class="judge-text">${escapeHtml(d.text)}</p>
          <div class="judge-actions">
            <button type="button" class="${j && j.rel === 1 ? "" : "secondary"}" data-judge="${escapeHtml(id)}" data-rel="1">Relevant</button>
            <button type="button" class="${j && j.rel === 0 ? "" : "secondary"}" data-judge="${escapeHtml(id)}" data-rel="0">Not relevant</button>
            <label class="toggle unsure"><input type="checkbox" data-unsure="${escapeHtml(id)}" ${j && j.unsure ? "checked" : ""} ${j ? "" : "disabled"} /> <span>Unsure</span></label>
            <a class="translate-link" href="${translate}" target="_blank" rel="noopener">Translate \u2197</a>
            <span class="doc-id">${escapeHtml(id)}</span>
          </div>
        </article>`;
    })
    .join("");

  const nextOpen = state.qrels.queries.findIndex((_, i) => i !== qi && !ev.perQuery[i].complete);

  evalJudgeEl.innerHTML = `
    <div class="judge-chips">${chips}</div>
    <div class="judge-query">
      <p class="judge-query-text"><code>${escapeHtml(q.text)}</code> <span class="gloss">${escapeHtml(q.gloss)}</span></p>
      <p class="judge-need"><strong>Relevant if:</strong> ${escapeHtml(q.need || "(no information need written)")}</p>
      <p class="note">${row.judgedCount} of ${row.poolSize} judged. Documents come from all three configurations in a fixed,
        shuffled order, so you can't tell which one found them. Judge each against the description above, not against
        whether it contains the query word. Mark <em>Unsure</em> when the translation leaves you in doubt.</p>
    </div>
    <div class="judge-list">${docs}</div>
    <div class="judge-footer">
      ${row.complete ? `<p class="ok-note">\u2713 This query is fully judged.</p>` : ""}
      ${
        nextOpen !== -1
          ? `<button type="button" data-judge-query="${nextOpen}">Next unjudged query: ${escapeHtml(state.qrels.queries[nextOpen].text)}</button>`
          : row.complete
          ? `<button type="button" data-goto-results>All queries judged. See results</button>`
          : ""
      }
    </div>`;
}

evalJudgeEl.addEventListener("click", (e) => {
  const qBtn = e.target.closest("[data-judge-query]");
  if (qBtn) {
    state.judgeQuery = Number(qBtn.dataset.judgeQuery);
    renderEval();
    evalTab.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (e.target.closest("[data-goto-results]")) return showEvalView("results");
  const jBtn = e.target.closest("[data-judge]");
  if (jBtn) {
    const q = state.qrels.queries[state.judgeQuery];
    const id = jBtn.dataset.judge;
    const prev = q.judgments[id];
    q.judgments[id] = { rel: Number(jBtn.dataset.rel), unsure: prev ? prev.unsure : false };
    const y = window.scrollY;
    saveQrels();
    onEvalDataChanged();
    window.scrollTo(0, y); // stay in place while working down the list
  }
});

evalJudgeEl.addEventListener("change", (e) => {
  const box = e.target.closest("[data-unsure]");
  if (!box) return;
  const q = state.qrels.queries[state.judgeQuery];
  const j = q.judgments[box.dataset.unsure];
  if (j) {
    j.unsure = box.checked;
    saveQrels();
    onEvalDataChanged();
  }
});

// --- qrels files ---

document.getElementById("download-qrels").addEventListener("click", () => {
  downloadJson("qrels.json", state.qrels);
});

document.getElementById("import-qrels").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state.qrels = validateQrels(JSON.parse(await file.text()));
    state.qrelsSource = "import";
    state.judgeQuery = 0;
    saveQrels();
    onEvalDataChanged();
  } catch (err) {
    alert(`Couldn't import qrels.json: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

document.getElementById("reset-qrels").addEventListener("click", () => {
  if (!confirm("Discard the judgments saved in this browser and reload data/qrels.json?")) return;
  try {
    localStorage.removeItem(QRELS_STORAGE_KEY);
  } catch {
    // ignore
  }
  state.qrels = validateQrels(JSON.parse(JSON.stringify(state.qrelsFile)));
  state.qrelsSource = "file";
  state.judgeQuery = 0;
  onEvalDataChanged();
});

// ---------------------------------------------------------------------
// Review tab (for a Somali-speaking reviewer)
// ---------------------------------------------------------------------
//
// Items come from data/review-set.json (built by tools/build-review-set.mjs).
// Answers are kept in state.review, saved to localStorage on every change
// and downloaded as a file for tools/analyse-review.mjs.
//
// Answer format:
// { version, setId, reviewer: { name }, updated,
//   groups:      { [id]: { outliers: [form], done, unsure, note } },
//   comparisons: { [id]: { choice: "a"|"b"|"both-good"|"both-bad", unsure, note } } }

const REVIEW_STORAGE_KEY = "xidid.review.v1";
const reviewBody = document.getElementById("review-body");
const reviewProgress = document.getElementById("review-progress");
const reviewName = document.getElementById("review-name");
const reviewTab = document.getElementById("tab-review");

function emptyReview() {
  return { version: 1, setId: state.reviewSet?.setId || null, reviewer: { name: "" }, updated: null, groups: {}, comparisons: {} };
}

function loadReview() {
  try {
    const raw = localStorage.getItem(REVIEW_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    // Answers belong to one review set; a different set starts fresh.
    if (saved && saved.setId === state.reviewSet?.setId) return saved;
  } catch {
    // fall through
  }
  return emptyReview();
}

function saveReview() {
  state.review.updated = new Date().toISOString();
  try {
    localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(state.review));
  } catch {
    // Storage unavailable: answers last for this session; Download keeps them.
  }
}

function reviewItems(view) {
  if (!state.reviewSet) return [];
  if (view === "comparisons") return state.reviewSet.comparisons;
  return state.reviewSet.groups.filter((g) => (view === "practice" ? g.sample === "practice" : g.sample !== "practice"));
}

function isAnswered(view, item) {
  return view === "comparisons" ? Boolean(state.review.comparisons[item.id]?.choice) : Boolean(state.review.groups[item.id]?.done);
}

function renderReviewProgress() {
  if (!state.reviewSet) {
    reviewProgress.textContent = "";
    return;
  }
  const count = (view) => {
    const items = reviewItems(view);
    return `${items.filter((it) => isAnswered(view, it)).length}/${items.length}`;
  };
  reviewProgress.textContent = `Practice ${count("practice")} \u00b7 Word groups ${count("groups")} \u00b7 Compare ${count("comparisons")}`;
}

function renderReview() {
  renderReviewProgress();
  if (!state.reviewSet) {
    reviewBody.innerHTML = `<p class="empty">No review set loaded. Create one with <code>node tools/build-review-set.mjs</code> (see README.md).</p>`;
    return;
  }
  reviewName.value = state.review.reviewer?.name || "";
  const view = state.reviewView;
  const items = reviewItems(view);
  if (!items.length) {
    reviewBody.innerHTML = `<p class="empty">Nothing in this section.</p>`;
    return;
  }
  const i = Math.min(state.reviewIndex[view] || 0, items.length - 1);
  state.reviewIndex[view] = i;
  const item = items[i];
  const label = view === "comparisons" ? "Comparison" : view === "practice" ? "Practice group" : "Group";
  const nextOpen = items.findIndex((it, j) => j > i && !isAnswered(view, it));
  const nav = `
    <div class="review-nav">
      <span>${label} ${i + 1} of ${items.length}${isAnswered(view, item) ? ' <span class="answered">\u2713 answered</span>' : ""}</span>
      <span class="review-nav-btns">
        <button type="button" class="secondary small" data-review-go="${i - 1}" ${i === 0 ? "disabled" : ""}>\u2190 Previous</button>
        <button type="button" class="secondary small" data-review-go="${i + 1}" ${i === items.length - 1 ? "disabled" : ""}>Next \u2192</button>
        ${nextOpen !== -1 ? `<button type="button" class="secondary small" data-review-go="${nextOpen}">Next unanswered</button>` : ""}
      </span>
    </div>`;
  const practiceNote =
    view === "practice"
      ? `<p class="note">Practice: do these together with the project owner in the first session, thinking aloud. They are not counted in the results.</p>`
      : "";
  reviewBody.innerHTML = practiceNote + nav + (view === "comparisons" ? renderComparisonItem(item) : renderGroupItem(item));
}

function exampleHtml(ex) {
  if (!ex) return `<span class="rf-example none">no example in the corpus</span>`;
  const safe = escapeHtml(ex.text);
  const w = escapeHtml(ex.word);
  const idx = safe.indexOf(w);
  const marked = idx === -1 ? safe : safe.slice(0, idx) + `<mark>${w}</mark>` + safe.slice(idx + w.length);
  return `<span class="rf-example">${marked}</span>`;
}

function renderGroupItem(g) {
  const ans = state.review.groups[g.id] || {};
  const out = new Set(ans.outliers || []);
  const rows = g.forms
    .map(
      (f) => `
      <li class="${out.has(f.form) ? "is-out" : ""}">
        <button type="button" class="form-toggle" data-out-form="${escapeHtml(f.form)}" aria-pressed="${out.has(f.form)}">
          <span class="rf-form">${escapeHtml(f.form)}</span>
          <span class="rf-flag">${out.has(f.form) ? "\u2717 doesn't belong" : "\u2713 belongs"}</span>
        </button>
        <span class="rf-count" title="occurrences">\u00d7${f.count}</span>
        ${exampleHtml(f.example)}
      </li>`
    )
    .join("");
  const hidden = g.totalForms - g.forms.length;
  return `
    <article class="review-card" data-item="${escapeHtml(g.id)}">
      <p class="review-q">Are these all forms of the <strong>same basic word</strong>? Click any word that does <strong>not</strong> belong.</p>
      <ul class="review-forms">${rows}</ul>
      ${hidden > 0 ? `<p class="note">+${hidden} rarer ${plural(hidden, "form", "forms")} not shown.</p>` : ""}
      <div class="review-actions">
        <button type="button" data-group-done="all" class="${ans.done && !out.size ? "" : "secondary"}">All belong together</button>
        <button type="button" data-group-done="marked" class="${ans.done && out.size ? "" : "secondary"}" ${out.size ? "" : "disabled"}>
          Done: ${out.size} ${plural(out.size, "word doesn't", "words don't")} belong</button>
        <label class="toggle unsure"><input type="checkbox" data-review-unsure ${ans.unsure ? "checked" : ""} /> <span>Not sure</span></label>
      </div>
      <label class="review-note">Note (optional, Somali or English)
        <textarea data-review-note rows="2">${escapeHtml(ans.note || "")}</textarea>
      </label>
    </article>`;
}

function renderComparisonItem(c) {
  const ans = state.review.comparisons[c.id] || {};
  const aSet = new Set(c.a.map((f) => f.form));
  const bSet = new Set(c.b.map((f) => f.form));
  const list = (forms, other, total) =>
    `<ul class="cmp-forms">${forms
      .map((f) => `<li class="${other.has(f.form) ? "" : "only"}">${escapeHtml(f.form)} <span class="rf-count">\u00d7${f.count}</span></li>`)
      .join("")}${total > forms.length ? `<li class="note">+${total - forms.length} more</li>` : ""}</ul>`;
  const choice = (value, text) =>
    `<button type="button" data-cmp-choice="${value}" class="${ans.choice === value ? "" : "secondary"}">${text}</button>`;
  return `
    <article class="review-card" data-item="${escapeHtml(c.id)}">
      <p class="review-q">Which group of words belongs with <strong class="cmp-word">${escapeHtml(c.word)}</strong>?</p>
      <p class="cmp-example">${exampleHtml(c.example)}</p>
      <div class="cmp-grid">
        <section><h3>Group A</h3>${list(c.a, bSet, c.aTotal)}</section>
        <section><h3>Group B</h3>${list(c.b, aSet, c.bTotal)}</section>
      </div>
      <p class="note">Highlighted words appear in only one of the two groups; that's where they differ.</p>
      <div class="review-actions">
        ${choice("a", "A is better")}
        ${choice("b", "B is better")}
        ${choice("both-good", "Both are fine")}
        ${choice("both-bad", "Both are wrong")}
        <label class="toggle unsure"><input type="checkbox" data-review-unsure ${ans.unsure ? "checked" : ""} /> <span>Not sure</span></label>
      </div>
      <label class="review-note">Note (optional, Somali or English)
        <textarea data-review-note rows="2">${escapeHtml(ans.note || "")}</textarea>
      </label>
    </article>`;
}

function currentReviewItem() {
  const items = reviewItems(state.reviewView);
  return items[state.reviewIndex[state.reviewView] || 0];
}

function answerFor(item) {
  const bucket = state.reviewView === "comparisons" ? state.review.comparisons : state.review.groups;
  if (!bucket[item.id]) bucket[item.id] = state.reviewView === "comparisons" ? {} : { outliers: [], done: false };
  return bucket[item.id];
}

function advanceReview() {
  const view = state.reviewView;
  const items = reviewItems(view);
  const i = state.reviewIndex[view] || 0;
  const next = items.findIndex((it, j) => j > i && !isAnswered(view, it));
  if (next !== -1) state.reviewIndex[view] = next;
  else if (i < items.length - 1) state.reviewIndex[view] = i + 1;
}

reviewTab.querySelectorAll("[data-review-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.reviewView = btn.dataset.reviewView;
    reviewTab.querySelectorAll("[data-review-view]").forEach((b) => b.classList.toggle("active", b === btn));
    renderReview();
  });
});

reviewBody.addEventListener("click", (e) => {
  const go = e.target.closest("[data-review-go]");
  if (go) {
    state.reviewIndex[state.reviewView] = Number(go.dataset.reviewGo);
    renderReview();
    return;
  }
  const item = currentReviewItem();
  if (!item) return;
  const toggle = e.target.closest("[data-out-form]");
  if (toggle) {
    const ans = answerFor(item);
    const set = new Set(ans.outliers);
    const f = toggle.dataset.outForm;
    if (set.has(f)) set.delete(f);
    else set.add(f);
    ans.outliers = [...set];
    if (ans.outliers.length === 0) ans.done = false; // "all belong" must be chosen explicitly
    saveReview();
    renderReview();
    return;
  }
  const done = e.target.closest("[data-group-done]");
  if (done) {
    const ans = answerFor(item);
    if (done.dataset.groupDone === "all") ans.outliers = [];
    ans.done = true;
    saveReview();
    advanceReview();
    renderReview();
    return;
  }
  const choice = e.target.closest("[data-cmp-choice]");
  if (choice) {
    answerFor(item).choice = choice.dataset.cmpChoice;
    saveReview();
    advanceReview();
    renderReview();
  }
});

reviewBody.addEventListener("change", (e) => {
  if (!e.target.matches("[data-review-unsure]")) return;
  const item = currentReviewItem();
  if (!item) return;
  answerFor(item).unsure = e.target.checked;
  saveReview();
  renderReviewProgress();
});

reviewBody.addEventListener("input", (e) => {
  if (!e.target.matches("[data-review-note]")) return;
  const item = currentReviewItem();
  if (!item) return;
  answerFor(item).note = e.target.value;
  saveReview();
});

reviewName.addEventListener("input", () => {
  state.review.reviewer = { name: reviewName.value.trim() };
  saveReview();
});

document.getElementById("download-review").addEventListener("click", () => {
  const who = (state.review.reviewer?.name || "reviewer").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "reviewer";
  downloadJson(`review-${who}-${state.review.setId || "set"}.json`, state.review);
});

document.getElementById("import-review").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== "object" || typeof data.groups !== "object" || typeof data.comparisons !== "object") {
      throw new Error("this doesn't look like a review file");
    }
    if (state.reviewSet && data.setId !== state.reviewSet.setId) {
      throw new Error(`it belongs to review set ${data.setId}, but the loaded set is ${state.reviewSet.setId}`);
    }
    state.review = { ...emptyReview(), ...data };
    saveReview();
    renderReview();
  } catch (err) {
    alert(`Couldn't import the review file: ${err.message}`);
  } finally {
    e.target.value = "";
  }
});

document.getElementById("clear-review").addEventListener("click", () => {
  if (!confirm("Delete all your review answers in this browser? Download the review file first if you want to keep them.")) return;
  state.review = emptyReview();
  saveReview();
  renderReview();
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function downloadJson(filename, data) {
  const text = JSON.stringify(data, null, 2);
  // Hosted as a Claude artifact, a page can't trigger downloads itself; it
  // asks the viewer through the "downloads" capability, which shows a
  // confirmation. Everywhere else (local server, GitHub Pages) window.claude
  // doesn't exist and the ordinary browser download below is used.
  if (typeof window.claude?.use === "function") {
    const downloads = await window.claude.use("downloads");
    if (downloads) {
      try {
        await downloads.save({ filename, data: text });
      } catch (err) {
        if (err?.code !== "declined") alert(`Couldn't save ${filename}: ${err?.message || err?.code || "unavailable here"}`);
      }
      return;
    }
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------
// Console hook (for testing from the browser's developer console)
// ---------------------------------------------------------------------
//
//   xidid.compare("dugsi")             -> Xidid vs raw: matches on each side
//   xidid.compare("dugsi", "snowball") -> Xidid vs the Snowball stemmer
//   xidid.buildRawIndex()   -> an unstemmed index of the current corpus
//   xidid.state.conflation  -> conflation classes + corpus statistics
//
// Read-only helpers; nothing here changes the UI.

window.xidid = {
  state,
  buildIndex,
  search,
  makeStemMapper,
  rawMapper,
  snowballStemmer,
  buildRawIndex: () => buildIndex(state.documents, rawMapper),
  compare(query, target = "raw") {
    const other = indexFor(target);
    if (!other) throw new Error(`unknown target "${target}" (use "raw" or "snowball")`);
    const stemmed = search(query, state.index, { topk: Infinity });
    const run = search(query, other, { topk: Infinity });
    const s = new Set(stemmed.results.map((r) => r.docId));
    const o = new Set(run.results.map((r) => r.docId));
    return {
      query,
      target,
      stemmedTerms: stemmed.trace.map((t) => t.term),
      [`${target}Terms`]: run.trace.map((t) => t.term),
      stemmedMatches: s.size,
      [`${target}Matches`]: o.size,
      foundOnlyByStemming: [...s].filter((id) => !o.has(id)),
      [`foundOnlyBy${target[0].toUpperCase()}${target.slice(1)}`]: [...o].filter((id) => !s.has(id)),
    };
  },
};

route();
init();
