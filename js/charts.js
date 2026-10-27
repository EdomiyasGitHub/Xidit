// Small, dependency-free SVG charts for the Evaluation tab.
//
// Each function returns an SVG string drawn at a given pixel width (the
// caller passes the container's width and redraws on resize), so text
// stays a readable size on phones instead of shrinking with a viewBox.

export const COLORS = {
  raw: "#a8a392",
  stemmed: "#5fa392",
  snowball: "#7fa7d1",
  gain: "#5fa392",
  loss: "#c99a45",
  axis: "#3a4b46",
  grid: "#26332f",
  text: "#c9c6ba",
  muted: "#8f8c7f",
};

const FONT = `font-family="IBM Plex Mono, ui-monospace, monospace"`;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const fmt = (v) => (v === null || v === undefined ? "\u2014" : v.toFixed(2));

function legend(x, y, items) {
  let out = "";
  let cx = x;
  for (const { label, color, line } of items) {
    out += line
      ? `<line x1="${cx}" y1="${y - 4}" x2="${cx + 16}" y2="${y - 4}" stroke="${color}" stroke-width="2.5"/>`
      : `<rect x="${cx}" y="${y - 10}" width="12" height="12" fill="${color}"/>`;
    out += `<text x="${cx + 20}" y="${y}" fill="${COLORS.text}" font-size="12" ${FONT}>${esc(label)}</text>`;
    cx += 30 + label.length * 7.5;
  }
  return out;
}

/**
 * Grouped bars: one group per metric, one bar per configuration.
 * groups: [{ label, values: { raw, stemmed } }]
 */
export function groupedBarChart(groups, { width = 640, configs = ["raw", "stemmed"], labels = {} } = {}) {
  const height = 260;
  const m = { top: 30, right: 10, bottom: 34, left: 34 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const groupW = w / groups.length;
  const barW = Math.min(46, (groupW * 0.7) / configs.length);
  const y = (v) => m.top + h - v * h;

  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Average metrics, raw vs stemmed">`;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    svg += `<line x1="${m.left}" x2="${width - m.right}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? COLORS.axis : COLORS.grid}"/>`;
    svg += `<text x="${m.left - 6}" y="${y(t) + 4}" text-anchor="end" fill="${COLORS.muted}" font-size="11" ${FONT}>${t}</text>`;
  }
  groups.forEach((g, gi) => {
    const gx = m.left + gi * groupW + (groupW - barW * configs.length) / 2;
    configs.forEach((c, ci) => {
      const v = g.values[c];
      const x = gx + ci * barW;
      if (v !== null && v !== undefined) {
        svg += `<rect x="${x + 2}" y="${y(v)}" width="${barW - 4}" height="${Math.max(0, y(0) - y(v))}" fill="${COLORS[c]}">
          <title>${esc(labels[c] || c)} ${esc(g.label)}: ${fmt(v)}</title></rect>`;
      }
      svg += `<text x="${x + barW / 2}" y="${(v ? y(v) : y(0)) - 5}" text-anchor="middle" fill="${COLORS.text}" font-size="11" ${FONT}>${fmt(v)}</text>`;
    });
    svg += `<text x="${m.left + gi * groupW + groupW / 2}" y="${height - 12}" text-anchor="middle" fill="${COLORS.text}" font-size="12" ${FONT}>${esc(g.label)}</text>`;
  });
  svg += legend(m.left, 14, configs.map((c) => ({ label: labels[c] || c, color: COLORS[c] })));
  return svg + `</svg>`;
}

/**
 * Diverging horizontal bars: one per query, value = stemmed AP - raw AP.
 * rows: [{ id, text, delta }] (already sorted)
 */
export function divergingBarChart(rows, { width = 640, posLabel = "stemming helped", negLabel = "stemming hurt", shortPos = "helped", shortNeg = "hurt" } = {}) {
  const rowH = 28;
  // Left margin fits the longest query label (≈7px per character at 12px
  // monospace), capped so the bars keep at least ~55% of the width.
  const longest = Math.max(4, ...rows.map((r) => r.text.length));
  const left = Math.min(Math.max(70, longest * 7.2 + 14), width * 0.42);
  const maxChars = Math.floor((left - 14) / 7.2);
  const label = (t) => (t.length > maxChars ? t.slice(0, maxChars - 1) + "\u2026" : t);
  const m = { top: 26, right: 48, bottom: 26, left };
  const narrow = width < 480;
  const height = m.top + m.bottom + rowH * Math.max(rows.length, 1);
  const w = width - m.left - m.right;
  const maxAbs = Math.max(0.25, ...rows.map((r) => Math.abs(r.delta)));
  const lim = Math.ceil(maxAbs * 4) / 4; // round up to a multiple of 0.25
  const x = (v) => m.left + ((v + lim) / (2 * lim)) * w;

  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Average precision difference per query">`;
  for (const t of [-lim, -lim / 2, 0, lim / 2, lim]) {
    svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${m.top - 6}" y2="${height - m.bottom}" stroke="${t === 0 ? COLORS.text : COLORS.grid}" ${
      t === 0 ? 'stroke-width="1"' : ""
    }/>`;
    svg += `<text x="${x(t)}" y="${height - 8}" text-anchor="middle" fill="${COLORS.muted}" font-size="11" ${FONT}>${
      t > 0 ? "+" : ""
    }${Number(t.toFixed(3))}</text>`;
  }
  svg += `<text x="${x(lim)}" y="14" text-anchor="end" fill="${COLORS.gain}" font-size="11" ${FONT}>${esc(narrow ? shortPos : posLabel)} \u2192</text>`;
  svg += `<text x="${x(-lim)}" y="14" text-anchor="start" fill="${COLORS.loss}" font-size="11" ${FONT}>\u2190 ${esc(narrow ? shortNeg : negLabel)}</text>`;

  rows.forEach((r, i) => {
    const cy = m.top + i * rowH + rowH / 2;
    const x0 = x(0);
    const x1 = x(r.delta);
    const color = r.delta >= 0 ? COLORS.gain : COLORS.loss;
    svg += `<g class="chart-row" data-query="${esc(r.text)}" tabindex="0" role="button" aria-label="${esc(r.text)}: ${
      r.delta >= 0 ? "+" : ""
    }${r.delta.toFixed(2)}">
      <rect x="0" y="${cy - rowH / 2}" width="${width}" height="${rowH}" fill="transparent"/>
      <text x="${m.left - 8}" y="${cy + 4}" text-anchor="end" fill="${COLORS.text}" font-size="12" ${FONT}>${esc(label(r.text))}</text>
      <rect x="${Math.min(x0, x1)}" y="${cy - 8}" width="${Math.max(Math.abs(x1 - x0), 1.5)}" height="16" fill="${color}"/>
      <text x="${r.delta >= 0 ? x1 + 5 : x1 - 5}" y="${cy + 4}" text-anchor="${r.delta >= 0 ? "start" : "end"}" fill="${color}" font-size="11" ${FONT}>${
      r.delta >= 0 ? "+" : ""
    }${r.delta.toFixed(2)}</text>
      <title>${esc(r.text)}: AP difference ${r.delta.toFixed(3)} (click to compare)</title>
    </g>`;
  });
  return svg + `</svg>`;
}

/**
 * Line chart of precision at ranks 1..10.
 * series: { raw: [10 values], stemmed: [10 values] }
 */
export function precisionAtRankChart(series, { width = 640, labels = {} } = {}) {
  const height = 240;
  const m = { top: 30, right: 16, bottom: 34, left: 34 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const x = (k) => m.left + ((k - 1) / 9) * w;
  const y = (v) => m.top + h - v * h;

  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Precision at each rank">`;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    svg += `<line x1="${m.left}" x2="${width - m.right}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? COLORS.axis : COLORS.grid}"/>`;
    svg += `<text x="${m.left - 6}" y="${y(t) + 4}" text-anchor="end" fill="${COLORS.muted}" font-size="11" ${FONT}>${t}</text>`;
  }
  for (let k = 1; k <= 10; k++) {
    svg += `<text x="${x(k)}" y="${height - 14}" text-anchor="middle" fill="${COLORS.muted}" font-size="11" ${FONT}>${k}</text>`;
  }
  svg += `<text x="${m.left + w / 2}" y="${height - 1}" text-anchor="middle" fill="${COLORS.muted}" font-size="11" ${FONT}>rank</text>`;
  for (const name of Object.keys(series)) {
    const pts = series[name].map((v, i) => (v === null ? null : [x(i + 1), y(v)])).filter(Boolean);
    if (!pts.length) continue;
    svg += `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${COLORS[name]}" stroke-width="2.5"/>`;
    series[name].forEach((v, i) => {
      if (v === null) return;
      svg += `<circle cx="${x(i + 1)}" cy="${y(v)}" r="3.5" fill="${COLORS[name]}"><title>${esc(labels[name] || name)} P@${i + 1} = ${v.toFixed(
        3
      )}</title></circle>`;
    });
  }
  svg += legend(m.left, 14, Object.keys(series).map((n) => ({ label: labels[n] || n, color: COLORS[n], line: true })));
  return svg + `</svg>`;
}
