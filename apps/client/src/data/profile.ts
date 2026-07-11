/**
 * Deterministic CSV profiling — the analysis a small on-device model can't be
 * trusted to drive itself. Runs in plain TS at dataset load (no sandbox, no
 * model): parse the CSV, classify each column, and compute the stats the
 * prompt and the dashboard template need. Everything downstream (the local
 * system prompt, the dashboard spec's column validation, the heuristic
 * fallback dashboard) is built on this profile.
 */

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

export type ColumnKind = "number" | "date" | "category" | "text";

export interface ColumnProfile {
  name: string;
  kind: ColumnKind;
  /** Empty/blank cells. */
  nullCount: number;
  distinctCount: number;
  /** Numeric columns. */
  min?: number;
  max?: number;
  mean?: number;
  sum?: number;
  /** Category columns: top values by frequency. */
  topValues?: { value: string; count: number }[];
  /** Date columns (ISO strings of the observed range). */
  dateMin?: string;
  dateMax?: string;
}

export interface DataProfile {
  rowCount: number;
  columns: ColumnProfile[];
}

/**
 * Minimal RFC-4180 CSV parser: quoted fields, embedded commas/newlines,
 * doubled quotes. Handles \r\n and trailing newline. Rows shorter than the
 * header are padded with "".
 */
export function parseCsv(text: string): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) endRow();
  if (!sawAny || rows.length === 0) return { header: [], rows: [] };

  const header = rows[0].map((h, i) => h.trim() || `column_${i + 1}`);
  const body = rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => (r.length >= header.length ? r.slice(0, header.length) : [...r, ...Array(header.length - r.length).fill("")]));
  return { header, rows: body };
}

const NUMERIC_RE = /^-?\$?[\d,]*\.?\d+%?$/;

/** Parse a cell as a number, tolerating $, thousands separators, and %. */
export function toNumber(cell: string): number | undefined {
  const t = cell.trim();
  if (!t || !NUMERIC_RE.test(t)) return undefined;
  const n = Number(t.replace(/[$,%]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/;

function toDate(cell: string): number | undefined {
  const t = cell.trim();
  if (!t || !DATE_RE.test(t)) return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
}

/** How many distinct values a column may have and still count as a category. */
function categoryLimit(rowCount: number): number {
  return Math.max(20, Math.floor(rowCount * 0.05));
}

export function profileCsv(text: string): DataProfile {
  const { header, rows } = parseCsv(text);
  const rowCount = rows.length;

  const columns: ColumnProfile[] = header.map((name, col) => {
    let nullCount = 0;
    let numeric = 0;
    let dates = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let dateMin = Infinity;
    let dateMax = -Infinity;
    const counts = new Map<string, number>();

    for (const r of rows) {
      const cell = (r[col] ?? "").trim();
      if (!cell) {
        nullCount++;
        continue;
      }
      counts.set(cell, (counts.get(cell) ?? 0) + 1);
      const n = toNumber(cell);
      if (n !== undefined) {
        numeric++;
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
        continue; // a numeric cell is never also a date
      }
      const d = toDate(cell);
      if (d !== undefined) {
        dates++;
        if (d < dateMin) dateMin = d;
        if (d > dateMax) dateMax = d;
      }
    }

    const nonNull = rowCount - nullCount;
    const distinctCount = counts.size;
    let kind: ColumnKind;
    if (nonNull > 0 && numeric >= nonNull * 0.9) kind = "number";
    else if (nonNull > 0 && dates >= nonNull * 0.9) kind = "date";
    else if (nonNull > 0 && distinctCount <= categoryLimit(rowCount)) kind = "category";
    else kind = "text";

    const profile: ColumnProfile = { name, kind, nullCount, distinctCount };
    if (kind === "number" && numeric > 0) {
      profile.min = min;
      profile.max = max;
      profile.sum = round(sum);
      profile.mean = round(sum / numeric);
    }
    if (kind === "category") {
      profile.topValues = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }));
    }
    if (kind === "date" && dates > 0) {
      profile.dateMin = isoDay(dateMin);
      profile.dateMax = isoDay(dateMax);
    }
    return profile;
  });

  return { rowCount, columns };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Compact, one-line-per-column profile block for the local system prompt. */
export function formatProfile(profile: DataProfile): string {
  const lines = [`${profile.rowCount} rows, ${profile.columns.length} columns:`];
  for (const c of profile.columns) {
    let detail = "";
    if (c.kind === "number") {
      detail = ` min=${c.min} max=${c.max} mean=${c.mean} sum=${c.sum}`;
    } else if (c.kind === "category") {
      const top = (c.topValues ?? []).map((t) => `${t.value}(${t.count})`).join(", ");
      detail = ` ${c.distinctCount} distinct; top: ${top}`;
    } else if (c.kind === "date") {
      detail = ` range ${c.dateMin}..${c.dateMax}`;
    }
    const nulls = c.nullCount > 0 ? ` (${c.nullCount} empty)` : "";
    lines.push(`- "${c.name}" [${c.kind}]${detail}${nulls}`);
  }
  return lines.join("\n");
}
