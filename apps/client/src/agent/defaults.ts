/**
 * Two things the dashboard needs but the model doesn't produce:
 *
 *  - `defaultWidgetsFromProfile` — a heuristic starter dashboard built from the
 *    deterministic data profile. Used as the safety net when a (usually small)
 *    model ends a turn without building anything, so the user always gets
 *    something useful, and as the seed the agent can then edit.
 *  - `exportDashboardHtml` — serialise the current widgets to a single
 *    self-contained .html file (Chart.js from a CDN, data pre-aggregated
 *    inline) so "Download dashboard" produces a portable artifact.
 */

import type { DataProfile } from "../data/profile";
import { parseCsv, type ParsedCsv } from "../data/profile";
import { chartSeries, formatNumber, metricValue } from "../data/aggregate";
import { nextWidgetId } from "../dashboard/DashboardStore";
import type { DashboardState, Widget } from "../dashboard/types";

/** A sensible dashboard derived purely from column kinds — no model needed. */
export function defaultWidgetsFromProfile(profile: DataProfile): Widget[] {
  const numbers = profile.columns.filter((c) => c.kind === "number");
  const categories = profile.columns.filter((c) => c.kind === "category");
  const date = profile.columns.find((c) => c.kind === "date");
  const anyColumn = profile.columns[0]?.name ?? "column_1";

  const widgets: Widget[] = [
    { id: nextWidgetId(), kind: "metric", label: "Rows", column: anyColumn, agg: "count" },
  ];
  if (numbers[0]) {
    widgets.push({ id: nextWidgetId(), kind: "metric", label: `Total ${numbers[0].name}`, column: numbers[0].name, agg: "sum" });
  }
  if (numbers[1]) {
    widgets.push({ id: nextWidgetId(), kind: "metric", label: `Avg ${numbers[1].name}`, column: numbers[1].name, agg: "mean" });
  }
  if (categories[0]) {
    widgets.push({
      id: nextWidgetId(),
      kind: "chart",
      chartType: "bar",
      title: numbers[0] ? `${numbers[0].name} by ${categories[0].name}` : `Rows by ${categories[0].name}`,
      x: categories[0].name,
      y: numbers[0]?.name,
      agg: numbers[0] ? "sum" : "count",
      filter: categories[1]?.name,
    });
  }
  if (date && numbers[0]) {
    widgets.push({
      id: nextWidgetId(),
      kind: "chart",
      chartType: "line",
      title: `${numbers[0].name} over ${date.name}`,
      x: date.name,
      y: numbers[0].name,
      agg: "sum",
    });
  }
  if (categories[1]) {
    widgets.push({ id: nextWidgetId(), kind: "chart", chartType: "pie", title: `Rows by ${categories[1].name}`, x: categories[1].name, agg: "count" });
  }
  if (!categories[0] && !date) {
    widgets.push({ id: nextWidgetId(), kind: "chart", chartType: "bar", title: `Rows by ${anyColumn}`, x: anyColumn, agg: "count" });
  }
  widgets.push({ id: nextWidgetId(), kind: "table", title: "Data" });
  return widgets;
}

/** The full starter dashboard (title + widgets) for a fresh dataset. */
export function defaultDashboardFromProfile(profile: DataProfile): DashboardState {
  return { title: "Data overview", widgets: defaultWidgetsFromProfile(profile) };
}

// ── standalone HTML export ───────────────────────────────────────────────────

const PALETTE = ["#4f46e5", "#f59f4f", "#059669", "#e0565b", "#9b6df5", "#38b6c9", "#c9a038", "#7a8699", "#d76fb1", "#5b8a3c", "#b05c3b", "#4d5bc9"];
const CHART_CDN = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
const MAX_EXPORT_ROWS = 500;

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Render the current widgets to a portable, self-contained HTML file. */
export function exportDashboardHtml(state: DashboardState, csv: string): string {
  const parsed: ParsedCsv = parseCsv(csv);
  const charts: { id: string; type: string; labels: string[]; values: number[]; multi: boolean }[] = [];
  const cards: string[] = [];

  for (const w of state.widgets) {
    if (w.kind === "metric") {
      cards.push(
        `<div class="card metric"><span>${esc(w.label)}</span><b>${esc(formatNumber(metricValue(parsed, w.column, w.agg)))}</b></div>`,
      );
    } else if (w.kind === "chart") {
      const s = w.data ?? chartSeries(parsed, w);
      const cid = "c_" + w.id;
      charts.push({ id: cid, type: w.chartType, labels: s.labels, values: s.values, multi: w.chartType === "pie" });
      cards.push(`<div class="card chart"><h2>${esc(w.title)}</h2><div class="box"><canvas id="${cid}"></canvas></div></div>`);
    } else if (w.kind === "table") {
      const cols = w.columns?.length ? w.columns : parsed.header;
      const idx = cols.map((c) => parsed.header.indexOf(c));
      const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
      const body = parsed.rows
        .slice(0, MAX_EXPORT_ROWS)
        .map((r) => `<tr>${idx.map((i) => `<td>${esc(i >= 0 ? r[i] ?? "" : "")}</td>`).join("")}</tr>`)
        .join("");
      cards.push(`<div class="card wide"><h2>${esc(w.title ?? "Data")}</h2><div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`);
    } else if (w.kind === "text") {
      cards.push(`<div class="card wide note">${esc(w.markdown).replace(/\n/g, "<br>")}</div>`);
    }
  }

  const chartInit = charts
    .map(
      (c) =>
        `new Chart(document.getElementById(${JSON.stringify(c.id)}),{type:${JSON.stringify(c.type)},` +
        `data:{labels:${JSON.stringify(c.labels)},datasets:[{data:${JSON.stringify(c.values)},` +
        `backgroundColor:${c.multi ? JSON.stringify(PALETTE) : JSON.stringify(PALETTE[0])},borderColor:${JSON.stringify(PALETTE[0])},fill:false,tension:.2}]},` +
        `options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:${c.multi}}},scales:${c.type === "pie" ? "{}" : "{y:{beginAtZero:true}}"}}});`,
    )
    .join("\n");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(state.title)}</title>
<script src="${CHART_CDN}"></script>
<style>
:root{--line:#e4e4e7;--muted:#71717a;}
*{box-sizing:border-box}
body{margin:0;padding:20px;font-family:system-ui,-apple-system,sans-serif;color:#1a1a1c;background:#f7f7f8}
h1{font-size:20px;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;align-items:start}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px}
.card.wide{grid-column:1/-1}
.metric span{color:var(--muted);font-size:12px}
.metric b{display:block;font-size:26px;margin-top:4px}
.chart h2,.card.wide h2{font-size:13px;margin:0 0 8px;color:var(--muted);font-weight:600}
.chart .box{position:relative;height:240px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}
th{background:#f3f3f7;position:sticky;top:0}
.tablewrap{max-height:340px;overflow:auto}
.note{white-space:pre-wrap}
</style></head>
<body>
<h1>${esc(state.title)}</h1>
<div class="grid">${cards.join("")}</div>
<script>${chartInit}</script>
</body></html>`;
}
