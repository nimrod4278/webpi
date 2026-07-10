/**
 * Spec-based dashboards — the small-model-shaped deliverable.
 *
 * On-device models (1.5–8B) can't reliably write a multi-thousand-token
 * dashboard.html inside a JSON tool argument, but they CAN emit ~200 tokens of
 * structured choices. The `save_dashboard_spec` tool takes that spec (title,
 * headline metrics, 2–3 charts, optional filter column), validates the column
 * names against the real CSV header, and renders a prebuilt self-contained
 * Chart.js template into the workspace at DASHBOARD_PATH — through the same
 * VirtualFS seam the cloud path's free-form `write` uses, so DashboardPreview
 * needs no changes.
 *
 * All aggregation is precomputed here from the FULL dataset (exact numbers,
 * including per-filter-value variants), so the template's JS only swaps
 * datasets on filter change. Only the data table falls back to a row sample.
 */

import { Type, type AgentTool, type AgentToolResult, type Static, type VirtualFS } from "wepi";
import { CHART_LIB_PATH, DASHBOARD_PATH } from "./prompts";
import { parseCsv, toNumber, type DataProfile, type ParsedCsv } from "./profile";

export type Agg = "sum" | "mean" | "count" | "min" | "max";

const aggSchema = Type.Union(
  [Type.Literal("sum"), Type.Literal("mean"), Type.Literal("count"), Type.Literal("min"), Type.Literal("max")],
  { description: "Aggregation: sum | mean | count | min | max" },
);

export const DashboardSpecSchema = Type.Object({
  title: Type.String({ description: "Short dashboard title" }),
  metrics: Type.Array(
    Type.Object({
      label: Type.String({ description: "Short metric label, e.g. 'Total revenue'" }),
      column: Type.String({ description: "Column to aggregate (any column when agg is 'count')" }),
      agg: aggSchema,
    }),
    { minItems: 1, maxItems: 4, description: "1-4 headline metrics" },
  ),
  charts: Type.Array(
    Type.Object({
      type: Type.Union([Type.Literal("bar"), Type.Literal("line"), Type.Literal("pie")], {
        description: "Chart type: bar | line | pie",
      }),
      title: Type.String({ description: "Chart title" }),
      xColumn: Type.String({ description: "Column for the x-axis / slices (line charts: a date or ordered column)" }),
      yColumn: Type.Optional(Type.String({ description: "Numeric column to aggregate per x value; omit to count rows" })),
      agg: aggSchema,
    }),
    { minItems: 1, maxItems: 3, description: "1-3 charts" },
  ),
  filterColumn: Type.Optional(
    Type.String({ description: "Optional category column to offer as an interactive filter" }),
  ),
});

export type DashboardSpec = Static<typeof DashboardSpecSchema>;

/** Max distinct filter values offered in the dropdown. */
const MAX_FILTER_OPTIONS = 12;
/** Bar/pie: keep the top N groups, fold the rest into "Other". */
const MAX_GROUPS = 12;
/** Line charts keep natural order; cap the number of points. */
const MAX_LINE_POINTS = 120;
/** Rows inlined for the data table (uniform sample above this). */
const MAX_TABLE_ROWS = 3000;

/**
 * The `save_dashboard_spec` agent tool. Column names are validated against
 * the real header — a mismatch returns an error listing the valid columns so
 * the model can self-correct on the next attempt.
 */
export function createSaveDashboardSpecTool(fs: VirtualFS, getCsv: () => string): AgentTool {
  let parsed: ParsedCsv | undefined;
  return {
    name: "save_dashboard_spec",
    label: "Save dashboard",
    description:
      "Render the interactive dashboard from a spec of metrics and charts. " +
      "Column names must match the dataset exactly. Calling it again replaces " +
      "the dashboard — always pass the complete spec, not a diff.",
    parameters: DashboardSpecSchema,
    execute: async (_id, args): Promise<AgentToolResult<unknown>> => {
      const spec = args as DashboardSpec;
      parsed ??= parseCsv(getCsv());

      const known = new Set(parsed.header);
      const referenced = [
        ...spec.metrics.map((m) => m.column),
        ...spec.charts.flatMap((c) => (c.yColumn ? [c.xColumn, c.yColumn] : [c.xColumn])),
        ...(spec.filterColumn ? [spec.filterColumn] : []),
      ];
      const unknown = [...new Set(referenced.filter((c) => !known.has(c)))];
      if (unknown.length > 0) {
        throw new Error(
          `Unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
            `Valid columns are: ${parsed.header.join(", ")}. Re-issue save_dashboard_spec with exact column names.`,
        );
      }

      fs.write(DASHBOARD_PATH, renderDashboardHtml(spec, parsed));
      return {
        content: [
          {
            type: "text",
            text:
              `Dashboard rendered to ${DASHBOARD_PATH}. Current spec: ${JSON.stringify(spec)} — ` +
              `call save_dashboard_spec again with a full updated spec to change it.`,
          },
        ],
        details: undefined,
      };
    },
  } as AgentTool;
}

/** Heuristic spec when the model never produced one — the user still gets a dashboard. */
export function defaultSpecFromProfile(profile: DataProfile): DashboardSpec {
  const numbers = profile.columns.filter((c) => c.kind === "number");
  const categories = profile.columns.filter((c) => c.kind === "category");
  const date = profile.columns.find((c) => c.kind === "date");
  const anyColumn = profile.columns[0]?.name ?? "column_1";

  const metrics: DashboardSpec["metrics"] = [{ label: "Rows", column: anyColumn, agg: "count" }];
  if (numbers[0]) metrics.push({ label: `Total ${numbers[0].name}`, column: numbers[0].name, agg: "sum" });
  if (numbers[1]) metrics.push({ label: `Avg ${numbers[1].name}`, column: numbers[1].name, agg: "mean" });

  const charts: DashboardSpec["charts"] = [];
  if (categories[0]) {
    charts.push({
      type: "bar",
      title: numbers[0] ? `${numbers[0].name} by ${categories[0].name}` : `Rows by ${categories[0].name}`,
      xColumn: categories[0].name,
      yColumn: numbers[0]?.name,
      agg: numbers[0] ? "sum" : "count",
    });
  }
  if (date && numbers[0]) {
    charts.push({
      type: "line",
      title: `${numbers[0].name} over ${date.name}`,
      xColumn: date.name,
      yColumn: numbers[0].name,
      agg: "sum",
    });
  }
  if (categories[1]) {
    charts.push({ type: "pie", title: `Rows by ${categories[1].name}`, xColumn: categories[1].name, agg: "count" });
  }
  if (charts.length === 0) {
    // No categories or dates at all — histogram-ish bar of the first column.
    charts.push({ type: "bar", title: `Rows by ${anyColumn}`, xColumn: anyColumn, agg: "count" });
  }

  return { title: "Data overview", metrics, charts, filterColumn: categories[0]?.name };
}

// ── aggregation (generation-time, exact over all rows) ──────────────────────

interface Series {
  labels: string[];
  data: number[];
}

function aggregate(values: number[], agg: Agg): number {
  if (agg === "count") return values.length;
  if (values.length === 0) return 0;
  switch (agg) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "mean":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}

/** Group `rows` by chart.xColumn and aggregate chart.yColumn (or count). */
function chartSeries(chart: DashboardSpec["charts"][number], rows: string[][], col: (name: string) => number): Series {
  const xi = col(chart.xColumn);
  const yi = chart.yColumn ? col(chart.yColumn) : -1;
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const x = (r[xi] ?? "").trim() || "(blank)";
    let bucket = groups.get(x);
    if (!bucket) groups.set(x, (bucket = []));
    if (yi >= 0) {
      const n = toNumber(r[yi] ?? "");
      if (n !== undefined) bucket.push(n);
    } else {
      bucket.push(1);
    }
  }

  const agg = chart.yColumn ? chart.agg : "count";
  let entries = [...groups.entries()].map(([label, vals]) => [label, aggregate(vals, agg)] as const);

  if (chart.type === "line") {
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (entries.length > MAX_LINE_POINTS) {
      const step = entries.length / MAX_LINE_POINTS;
      entries = Array.from({ length: MAX_LINE_POINTS }, (_, i) => entries[Math.floor(i * step)]);
    }
  } else {
    entries.sort((a, b) => b[1] - a[1]);
    if (entries.length > MAX_GROUPS) {
      const rest = entries.slice(MAX_GROUPS - 1);
      entries = entries.slice(0, MAX_GROUPS - 1);
      entries.push(["Other", round2(rest.reduce((a, [, v]) => a + v, 0))]);
    }
  }

  return { labels: entries.map((e) => e[0]), data: entries.map((e) => round2(e[1])) };
}

function metricValue(metric: DashboardSpec["metrics"][number], rows: string[][], col: (name: string) => number): number {
  if (metric.agg === "count") return rows.length;
  const ci = col(metric.column);
  const values: number[] = [];
  for (const r of rows) {
    const n = toNumber(r[ci] ?? "");
    if (n !== undefined) values.push(n);
  }
  return round2(aggregate(values, metric.agg));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── template ─────────────────────────────────────────────────────────────────

/**
 * Render the self-contained dashboard HTML. Aggregates (metrics + chart
 * series) are precomputed per filter option — "All" plus each of the top
 * filter values — so the embedded JS is data plumbing, not analysis.
 */
export function renderDashboardHtml(spec: DashboardSpec, data: ParsedCsv): string {
  const col = (name: string): number => {
    const i = data.header.indexOf(name);
    if (i < 0) throw new Error(`Unknown column: ${name}. Valid columns are: ${data.header.join(", ")}`);
    return i;
  };

  // Filter options: the most frequent values of the filter column.
  let filterValues: string[] = [];
  if (spec.filterColumn) {
    const fi = col(spec.filterColumn);
    const counts = new Map<string, number>();
    for (const r of data.rows) {
      const v = (r[fi] ?? "").trim();
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    filterValues = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_FILTER_OPTIONS)
      .map(([v]) => v);
  }

  const ALL = "__all__";
  const options = [ALL, ...filterValues];
  const rowsFor = (option: string): string[][] => {
    if (option === ALL || !spec.filterColumn) return data.rows;
    const fi = col(spec.filterColumn);
    return data.rows.filter((r) => (r[fi] ?? "").trim() === option);
  };

  const views: Record<string, { metrics: number[]; charts: Series[] }> = {};
  for (const option of options) {
    const rows = rowsFor(option);
    views[option] = {
      metrics: spec.metrics.map((m) => metricValue(m, rows, col)),
      charts: spec.charts.map((c) => chartSeries(c, rows, col)),
    };
  }

  // Table rows: uniform sample when large (charts/metrics stay exact above).
  let tableRows = data.rows;
  let sampled = false;
  if (tableRows.length > MAX_TABLE_ROWS) {
    const step = tableRows.length / MAX_TABLE_ROWS;
    tableRows = Array.from({ length: MAX_TABLE_ROWS }, (_, i) => data.rows[Math.floor(i * step)]);
    sampled = true;
  }

  const payload = {
    title: spec.title,
    metrics: spec.metrics.map((m) => ({ label: m.label })),
    charts: spec.charts.map((c) => ({ type: c.type, title: c.title })),
    filter: spec.filterColumn ? { column: spec.filterColumn, values: filterValues } : null,
    filterIndex: spec.filterColumn ? col(spec.filterColumn) : -1,
    views,
    header: data.header,
    rows: tableRows,
    sampled,
    totalRows: data.rows.length,
  };

  // </script> inside the JSON would terminate the inline script block early.
  const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.title)}</title>
<script src="${CHART_LIB_PATH}"></script>
<style>
  :root { --line: #e3e3e8; --muted: #6b6b76; --accent: #4f6df5; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; font-family: system-ui, -apple-system, sans-serif; color: #1c1c22; background: #fafafc; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .metric { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .metric b { display: block; font-size: 22px; margin-top: 4px; }
  .metric span { color: var(--muted); font-size: 12px; }
  .filter { margin-bottom: 16px; font-size: 13px; color: var(--muted); }
  .filter select { margin-left: 8px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .chart { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
  .chart h2 { font-size: 13px; margin: 0 0 8px; color: var(--muted); font-weight: 600; }
  .chart .box { position: relative; height: 240px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--line); border-radius: 10px; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  th { cursor: pointer; user-select: none; background: #f3f3f7; position: sticky; top: 0; }
  .tablewrap { max-height: 320px; overflow: auto; border-radius: 10px; }
  .note { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
</style>
</head>
<body>
<h1 id="title"></h1>
<div class="filter" id="filter" hidden>
  Filter by <span id="filter-col"></span>:
  <select id="filter-sel"></select>
</div>
<div class="metrics" id="metrics"></div>
<div class="charts" id="charts"></div>
<div class="tablewrap"><table id="table"></table></div>
<p class="note" id="note"></p>
<script>
var DASH = ${payloadJson};
var ALL = "${ALL}";
var current = ALL;
var chartObjs = [];
var sortCol = -1, sortAsc = true;

document.getElementById("title").textContent = DASH.title;

function fmt(n) {
  if (typeof n !== "number" || !isFinite(n)) return "–";
  return Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(Math.round(n * 100) / 100);
}

function renderMetrics() {
  var view = DASH.views[current] || DASH.views[ALL];
  var host = document.getElementById("metrics");
  host.innerHTML = "";
  DASH.metrics.forEach(function (m, i) {
    var el = document.createElement("div");
    el.className = "metric";
    el.innerHTML = "<span></span><b></b>";
    el.querySelector("span").textContent = m.label;
    el.querySelector("b").textContent = fmt(view.metrics[i]);
    host.appendChild(el);
  });
}

var PALETTE = ["#4f6df5", "#f59f4f", "#43b581", "#e0565b", "#9b6df5", "#38b6c9", "#c9a038", "#7a8699", "#d76fb1", "#5b8a3c", "#b05c3b", "#4d5bc9"];

function buildCharts() {
  var host = document.getElementById("charts");
  DASH.charts.forEach(function (c, i) {
    var card = document.createElement("div");
    card.className = "chart";
    card.innerHTML = "<h2></h2><div class='box'><canvas></canvas></div>";
    card.querySelector("h2").textContent = c.title;
    host.appendChild(card);
    var view = DASH.views[current];
    var s = view.charts[i];
    var multi = c.type === "pie";
    chartObjs.push(new Chart(card.querySelector("canvas"), {
      type: c.type,
      data: {
        labels: s.labels,
        datasets: [{
          data: s.data,
          backgroundColor: multi ? PALETTE : PALETTE[i % PALETTE.length],
          borderColor: c.type === "line" ? PALETTE[i % PALETTE.length] : undefined,
          fill: false,
          tension: 0.2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: multi } },
        scales: c.type === "pie" ? {} : { y: { beginAtZero: true } },
      },
    }));
  });
}

function updateCharts() {
  var view = DASH.views[current] || DASH.views[ALL];
  chartObjs.forEach(function (chart, i) {
    var s = view.charts[i];
    chart.data.labels = s.labels;
    chart.data.datasets[0].data = s.data;
    chart.update();
  });
}

function visibleRows() {
  var rows = DASH.rows;
  if (current !== ALL && DASH.filterIndex >= 0) {
    rows = rows.filter(function (r) { return (r[DASH.filterIndex] || "").trim() === current; });
  }
  if (sortCol >= 0) {
    rows = rows.slice().sort(function (a, b) {
      var av = a[sortCol] || "", bv = b[sortCol] || "";
      var an = parseFloat(av.replace(/[$,%]/g, "")), bn = parseFloat(bv.replace(/[$,%]/g, ""));
      var cmp = isFinite(an) && isFinite(bn) ? an - bn : av.localeCompare(bv);
      return sortAsc ? cmp : -cmp;
    });
  }
  return rows;
}

function renderTable() {
  var table = document.getElementById("table");
  var rows = visibleRows().slice(0, 500);
  var html = "<thead><tr>";
  DASH.header.forEach(function (h, i) {
    html += "<th data-i='" + i + "'>" + esc(h) + (sortCol === i ? (sortAsc ? " ▲" : " ▼") : "") + "</th>";
  });
  html += "</tr></thead><tbody>";
  rows.forEach(function (r) {
    html += "<tr>" + r.map(function (c) { return "<td>" + esc(c) + "</td>"; }).join("") + "</tr>";
  });
  table.innerHTML = html + "</tbody>";
  table.querySelectorAll("th").forEach(function (th) {
    th.onclick = function () {
      var i = Number(th.dataset.i);
      if (sortCol === i) sortAsc = !sortAsc; else { sortCol = i; sortAsc = true; }
      renderTable();
    };
  });
  var note = [];
  if (DASH.sampled) note.push("Table shows a uniform sample of " + DASH.rows.length + " of " + DASH.totalRows + " rows (metrics and charts use all rows).");
  if (visibleRows().length > 500) note.push("Showing the first 500 matching rows.");
  document.getElementById("note").textContent = note.join(" ");
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

if (DASH.filter && DASH.filter.values.length > 0) {
  var wrap = document.getElementById("filter");
  wrap.hidden = false;
  document.getElementById("filter-col").textContent = DASH.filter.column;
  var sel = document.getElementById("filter-sel");
  var optAll = document.createElement("option");
  optAll.value = ALL;
  optAll.textContent = "All";
  sel.appendChild(optAll);
  DASH.filter.values.forEach(function (v) {
    var o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  });
  sel.onchange = function () {
    current = sel.value;
    renderMetrics();
    updateCharts();
    renderTable();
  };
}

renderMetrics();
if (typeof Chart !== "undefined") buildCharts();
renderTable();
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
