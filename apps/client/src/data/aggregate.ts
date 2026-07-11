/**
 * Deterministic aggregation over a parsed CSV — the number-crunching behind
 * every widget and the `query_data` tool. Runs in plain TS on the main thread
 * (no model, no sandbox), so a metric or chart shows exact numbers regardless
 * of how small the model driving the agent is.
 *
 * Extracted from the old spec-based dashboard so both the live React widgets
 * and the agent's tools share one source of truth for "group by X, aggregate Y".
 */

import { toNumber, type ParsedCsv } from "./profile";

export type Agg = "sum" | "mean" | "count" | "min" | "max";
export type ChartType = "bar" | "line" | "pie";

/** A chart's plottable shape: parallel label/value arrays. */
export interface Series {
  labels: string[];
  values: number[];
}

/** Filter a view down to rows where `column` equals `value`. */
export interface Filter {
  column: string;
  value: string;
}

/** Bar/pie: keep the top N groups, fold the rest into "Other". */
export const MAX_GROUPS = 12;
/** Line charts keep natural order; cap the number of points. */
export const MAX_LINE_POINTS = 120;
/** Max distinct values offered in a filter dropdown. */
export const MAX_FILTER_OPTIONS = 12;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Column index by exact name, or -1 if absent. */
export function colIndex(parsed: ParsedCsv, name: string): number {
  return parsed.header.indexOf(name);
}

/** The subset of `names` that aren't real columns (for validation messages). */
export function unknownColumns(parsed: ParsedCsv, names: (string | undefined)[]): string[] {
  const known = new Set(parsed.header);
  return [...new Set(names.filter((n): n is string => !!n && !known.has(n)))];
}

/** Rows after applying an optional single-value filter. */
export function rowsFor(parsed: ParsedCsv, filter?: Filter): string[][] {
  if (!filter) return parsed.rows;
  const fi = colIndex(parsed, filter.column);
  if (fi < 0) return parsed.rows;
  return parsed.rows.filter((r) => (r[fi] ?? "").trim() === filter.value);
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

/** A single headline number: aggregate one column across (filtered) rows. */
export function metricValue(parsed: ParsedCsv, column: string, agg: Agg, filter?: Filter): number {
  const rows = rowsFor(parsed, filter);
  if (agg === "count") return rows.length;
  const ci = colIndex(parsed, column);
  if (ci < 0) return 0;
  const values: number[] = [];
  for (const r of rows) {
    const n = toNumber(r[ci] ?? "");
    if (n !== undefined) values.push(n);
  }
  return round2(aggregate(values, agg));
}

/**
 * Group `x` and aggregate `y` (or count rows when `y` is omitted). Returns
 * `[label, value]` pairs; the caller decides sorting/capping. Used by both the
 * chart renderer and the `query_data` tool.
 */
export function groupAggregate(
  parsed: ParsedCsv,
  x: string,
  y: string | undefined,
  agg: Agg,
  filter?: Filter,
): [string, number][] {
  const rows = rowsFor(parsed, filter);
  const xi = colIndex(parsed, x);
  const yi = y ? colIndex(parsed, y) : -1;
  if (xi < 0) return [];
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const key = (r[xi] ?? "").trim() || "(blank)";
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, (bucket = []));
    if (yi >= 0) {
      const n = toNumber(r[yi] ?? "");
      if (n !== undefined) bucket.push(n);
    } else {
      bucket.push(1);
    }
  }
  const effectiveAgg = y ? agg : "count";
  return [...groups.entries()].map(([label, vals]) => [label, round2(aggregate(vals, effectiveAgg))]);
}

/** Chart-ready series: sort + cap according to the chart type. */
export function chartSeries(
  parsed: ParsedCsv,
  chart: { chartType: ChartType; x: string; y?: string; agg: Agg },
  filter?: Filter,
): Series {
  let entries = groupAggregate(parsed, chart.x, chart.y, chart.agg, filter);
  if (chart.chartType === "line") {
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
  return { labels: entries.map((e) => e[0]), values: entries.map((e) => e[1]) };
}

/** The most frequent distinct values of a column (for filter dropdowns). */
export function distinctTop(parsed: ParsedCsv, column: string, max = MAX_FILTER_OPTIONS): string[] {
  const ci = colIndex(parsed, column);
  if (ci < 0) return [];
  const counts = new Map<string, number>();
  for (const r of parsed.rows) {
    const v = (r[ci] ?? "").trim();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([v]) => v);
}

/** Format a number for compact display (thousands separators, ≤1 decimal). */
export function formatNumber(n: number): string {
  if (typeof n !== "number" || !isFinite(n)) return "–";
  return Math.abs(n) >= 1000
    ? n.toLocaleString(undefined, { maximumFractionDigits: 1 })
    : String(round2(n));
}
