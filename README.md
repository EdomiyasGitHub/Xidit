# Xidid — Somali Search & Stemmer

**Xidid** is a client-side web app built on top of the `somali_stemmer` package: a
small vector-space IR system (tokenize → stem → TF-IDF → cosine
similarity ranking, with an inverted index for candidate lookup) plus a
"Stemmer Lab" tab that shows the affix-stripping algorithm's reasoning
for individual words. Pure HTML/CSS/JS — no backend, no build step.

## Running it

Browsers block `fetch()` of local JSON files opened via `file://`, and
this app loads `data/*.json` with `fetch`. Serve the folder instead —
any of these work:

```bash
# Python (already on most systems)
cd somali-ir-webapp
python -m http.server 8000
# then open http://localhost:8000

# Node
npx serve somali-ir-webapp

# VS Code
# Right-click index.html -> "Open with Live Server"
```

## Layout

```
somali-ir-webapp/
├── snowball/
│   └── somali.sbl         Source of the rules-only Snowball stemmer
├── tools/                 Node command-line tools (review set, analysis, word lists)
├── assets/                Promo film (MP4 + WebM fallback) and its poster image
├── promo/                 Source of the promo film (stage, captures, render scripts)
├── package.json           Only for the Node tools; the web app needs no install
├── index.html            Two-tab UI: Search, Stemmer Lab
├── css/style.css
├── js/
│   ├── config.js          Ported from config.py
│   ├── affixes.js         Ported from affixes.py
│   ├── textUtils.js       Ported from text_utils.py (normalize)
│   ├── stemmer.js         Ported from stemmer.py (stem/stemText),
│   │                      + stemVerbose() for the Lab tab's breakdown
│   ├── ngram.js           Ported from ngram.py (fuzzy suggestions)
│   ├── conflation.js      Conflation classes + corpus statistics
│   ├── eval.js            Pooling, P@k, Recall@10, AP/MAP
│   ├── snowball/          Generated Snowball Somali stemmer + runtime (BSD)
│   ├── charts.js          Dependency-free SVG charts (Evaluation tab)
│   ├── ir.js              New: tokenizer, inverted index, TF-IDF
│   │                      vectors, cosine-similarity search, highlighting
│   └── app.js             New: wires data loading + both tabs
└── data/
    ├── protected_words.json  copied from your project
    ├── stem_overrides.json   copied from your project
    ├── somali_words.json     copied from your project (10,503-word lexicon)
    ├── qrels.json            10 test queries + your relevance judgments
    ├── qrels.sample-synthetic.json  keyword-generated judgments, testing only
    ├── review-set.json       Items for the Somali-speaker review (generated)
    └── corpus.json           300 SOPC-v2 documents (see below)
```

The `js/*.js` stemmer files are a direct port of your Python package —
same affix lists, same lexicon-gated stripping logic, same
prefix/suffix pass structure, same reduplication collapsing. Nothing
about the stemming algorithm itself changed.

## About `data/corpus.json`

`corpus.json` contains a 300-document subset of the Somali Open
Pre-Training Corpus v2 (SOPC-v2), balanced across eight categories:
health, business, culture, education, agriculture, technology, stories,
and news. It is licensed under CC BY 4.0. See
[`data/CORPUS_SOURCES.md`](data/CORPUS_SOURCES.md) for the complete source
and attribution information.

You can still edit `data/corpus.json` directly (an array of documents) or
add documents during a browser session. Session-added documents are not
saved back to disk.

## What the IR pipeline does

1. **Tokenize** — split on non-letters (unicode-aware).
2. **Stem** — same `stem()` used by the CLI, lexicon-gated.
3. **Index** — build an inverted index (stem → documents containing
   it) and a TF-IDF weight vector per document.
4. **Query** — process the query with the *same* term mapper the index
   was built with (stored on the index), build a TF-IDF query vector,
   and rank candidate documents (pulled from the inverted index, not a
   full corpus scan) by cosine similarity.
5. **Highlight** — in results, any original word that stems to a
   query term is highlighted, so you can show that matching happens
   on stems, not surface forms (e.g. searching `guri` also finds
   `guryaha`).

### Pluggable term mapping

`buildIndex(documents, mapTerm)` takes a function that turns a token into
an index term:

- `makeStemMapper(stemOpts)` — the Somali stemmer (the default).
- `rawMapper` — lowercase only, no stemming. Used as the baseline when
  comparing what stemming adds.

Because `tf` is divided by document length and cosine similarity then
divides by the vector norm, the length division cancels out: rankings
depend only on raw counts × idf. Document length only counts tokens that
produced a term.

Known limitation: only document **text** is indexed, not titles.

## Comparing stemmed and raw search

Tick **Compare with unstemmed search** on the Search tab. Xidid keeps two
indexes of the same corpus (stemmed and raw) and shows both rankings side
by side. Documents only the stemmed index found are marked *found via
stemming*; documents only the raw index found are marked *lost by
stemming*. Each stemmed result lists the actual word forms that matched
("matched via dugsiga"); click one to see its stemming trace in the Lab.

Good queries to try: `dugsi` (0 raw vs 12 stemmed), `saacad` (1 vs 9),
and `ubax` (1 vs 13, nearly all wrong: overstemming to `bax`).

## Why this result?

Every result card has a **Why this result?** panel that breaks the score
into one row per query term: the word forms that matched in this
document, count / document length, df, idf, the document and query
weights, and that term's contribution and share of the score:

    cos(q, d) = Σ w(q,t) · w(d,t) / (‖q‖ · ‖d‖)
    w(x,t)    = (count of t in x / length of x) · ln(N / df(t))

Each contribution is already divided by both norms, so the rows add up
exactly to the displayed score; the panel checks this and says so. Query
terms that didn't count are shown greyed out with the reason (not in this
document, not in the index, or in every document so idf = 0).
`explain(query, docId, index)` in `ir.js` uses the same query-vector code
as `search()` (`buildQueryVector`), so the explanation can't drift from
the ranking. Works in both the stemmed and raw columns.

Note: result cards round scores to 3 decimals; the panel shows 4.

## Conflation tab

Shows what stemming did to the vocabulary: word tokens, distinct word
forms, distinct stems, the vocabulary reduction, and the largest
conflation classes (stems that absorbed the most forms). Look up any word
or stem to see every form that shares its index term.

It also flags **unstable terms**: index terms that stem to something else
when stemmed again (the stemmer isn't idempotent for them). Example:
`lacag` ("money") stems to `cag` ("foot"), but `lacagaha` and `lacagtii`
stem to `lacag`, so money-related forms are split across two terms and a
search for `lacag` misses some of them.

## Session-only edits

The Stemmer Lab tab lets you add/remove protected words and overrides
during the session. Every change rebuilds the search index immediately,
so results update straight away. Use the Download/Import JSON buttons to
save and reload them (there's no server to write to disk directly). The
Search tab's corpus panel has the same Download/Import for `corpus.json`.

## Testing from the browser console

`app.js` exposes a small read-only helper on `window.xidid`:

```js
xidid.compare("dugsi")   // stemmed vs raw match counts, and which docs differ
xidid.buildRawIndex()    // an unstemmed index of the current corpus
xidid.state              // loaded lexicon, overrides, documents, index
```

## Not carried over from the CLI

The Python CLI also supports `--use-ngram`/`--show-candidates` flags
and a REPL. The web app folds the n-gram fuzzy-suggestion feature into
the Stemmer Lab tab automatically (shown only when a stem isn't
lexicon-confirmed) rather than as a separate flag, since that reads
more naturally in a UI than a CLI switch.

## Evaluation tab

Measures whether stemming improves retrieval, using a small test
collection in `data/qrels.json`: 10 queries, each with an English
gloss and a written information need ("Relevant if: …").

**Judging.** Evaluation > Judge shows, for each query, the *pool*: the
union of the top 10 documents from the raw and stemmed configurations, in
a fixed shuffled order so the judge can't tell which system found which
document. Mark each Relevant / Not relevant (and Unsure if the
translation leaves doubt); each card has a Google Translate link.
Judgments save to this browser automatically; **Download qrels.json** and
save it into `data/` to keep them with the project.

**Results.** For every fully judged query, each configuration is scored
on its full ranking:

- P@5, P@10: share of the top 5 / 10 that is relevant
- Recall@10: share of the known relevant documents found in the top 10
- AP: average of P@rank over the ranks where relevant documents appear,
  divided by the number of known relevant documents; MAP is its mean

Charts: average metrics (raw vs stemmed), per-query AP difference
(click a bar to open that query side by side), and precision at ranks
1–10. Metrics are recomputed whenever judgments or stemmer settings
change; if an override changes a pool, that query becomes incomplete
until the new documents are judged.

`data/qrels.sample-synthetic.json` was generated by a keyword rule so the
dashboard can be tested before real judging. It is **not** a relevance
judgment set and is biased towards stemming by construction; the app
shows a warning banner whenever it is loaded.

## Three configurations: Raw, Xidid, Snowball

Xidid builds three indexes of the same corpus:

- **Raw**: lowercase tokens, no stemming (the baseline).
- **Xidid**: the lexicon-gated stemmer (`stemmer.js`).
- **Snowball**: a rules-only port of the same suffix rules, written in
  Snowball (`snowball/somali.sbl`) and compiled to JavaScript with the
  official compiler (`js/snowball/`). It has no dictionary and no prefix
  stripping. It is a prototype towards contributing a Somali stemmer to
  the Snowball project, not yet reviewed by a Somali speaker.

Where they appear:

- **Search › Compare**: Xidid is always on the left; choose Raw or
  Snowball for the right column.
- **Conflation**: switch between the Xidid and Snowball vocabularies.
  Snowball merges more (31.9% vs 17.9% reduction); `xaalad`
  ("situation") is the clearest case where that helps.
- **Stemmer Lab**: each card also shows the Snowball result.
- **Evaluation**: pools are the top 10 of all three; the table and charts
  show all three; choose which pair the per-query chart compares.

## Change to the stemmer: prefix tie-break

When a word can be read both with and without a leading particle
(ku/ka/la/u), and both readings are dictionary words, Xidid now keeps
the reading **without** prefix stripping. The original Python package
preferred the prefix-stripped reading, which truncated ordinary words:
`lacag` "money" → `cag` "foot", `ubax` "flower" → `bax` "go out",
`kariyo` "cooked" → `riyo` "dream", `kursi` "chair" → `rse`. This
changed the stem of 29 corpus forms (78 lexicon words) and nothing else.
This is a deliberate deviation from the Python package.

## Review tab and tools (Somali-speaker review)

The **Review** tab is for a Somali-speaking reviewer. It shows the
Snowball stemmer's word groups (each word with its count and an example
sentence from the corpus); the reviewer marks any form that doesn't
belong. It also shows words that Xidid and Snowball group differently, as
anonymous "Group A / Group B", and asks which is better. Answers save in
the browser and are downloaded as a review file.

The tools in `tools/` need Node.js 18 or newer and nothing else (no
`npm install`):

```sh
# Build the review set (data/review-set.json) from the corpus...
node tools/build-review-set.mjs
# ...or from a Wikipedia frequency list (example sentences still come from the corpus)
node tools/build-review-set.mjs --freq so.filtered.freq

# Turn one or more review files into a report with rule suggestions
node tools/analyse-review.mjs review-NAME-SETID.json [second-reviewer.json] --out reports/review-report.md

# Word list for snowball-data, after Snowball's scripts/wikipedia-dump-to-freq
node tools/filter-somali-freq.mjs so.freq --out so.filtered.freq --rejected so.rejected.tsv
cut -f2 so.filtered.freq | sort > voc.txt
node tools/stem-vocab.mjs voc.txt --out output.txt --compare
```

Rebuilding the review set changes its `setId`; review files are tied to
one set, so don't rebuild it while a review is in progress.

## Landing page and promo film

The site opens on a landing page (hero, a 30-second silent tour, key
figures, the five tools, and an honest list of limitations). The app
loads its data in the background meanwhile. Addresses:

- no `#fragment`, `#welcome` or `#tour` → landing page
- `#search`, `#explorer`, `#lab`, `#eval`, `#review` → the app on that tab
  (send a reviewer `…/#review` to skip the landing page)

Clicking a tab updates the address, so reloading keeps your place. The
film autoplays muted and loops; it doesn't autoplay for visitors who
prefer reduced motion. Its source and re-render instructions are in
`promo/README.md`.

## Hosting

The site is static: any web server can host the folder as it is.

- **Cloudflare** (main host): `wrangler.jsonc` deploys the folder as an
  assets-only Worker, with no server code. `.assetsignore` keeps tools, the
  film source and docs out of the upload. Patterns there start with `/` on
  purpose: an unanchored `snowball` would also hide `js/snowball/`, which
  the app needs. Deploy by connecting the GitHub repository in the
  Cloudflare dashboard, or from a terminal with `npx wrangler deploy`.
- **GitHub Pages** (alternative): *Settings › Pages*, deploy from branch
  `main`, folder `/ (root)`.
- **Single file** (offline sharing): `node tools/build-single-file.mjs`
  writes `dist/xidid.html` with everything embedded (about 4 MB).

Direct links work everywhere, e.g. `…/#review` opens the Review tab.
