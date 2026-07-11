/** A sortable, optionally-filtered data table over the (subset of) columns. */

import { useMemo, useState } from "react";
import type { ParsedCsv } from "../../data/profile";
import { distinctTop } from "../../data/aggregate";
import type { Widget } from "../types";

const ALL = "__all__";
const MAX_ROWS = 500;

export function TableWidget({ widget, parsed }: { widget: Extract<Widget, { kind: "table" }>; parsed: ParsedCsv }) {
  const [sort, setSort] = useState<{ col: number; asc: boolean } | undefined>();
  const [sel, setSel] = useState(ALL);

  const cols = widget.columns?.length ? widget.columns : parsed.header;
  const colIdx = useMemo(() => cols.map((c) => parsed.header.indexOf(c)), [cols, parsed.header]);
  const filterIdx = widget.filter ? parsed.header.indexOf(widget.filter) : -1;
  const filterOptions = useMemo(
    () => (widget.filter ? distinctTop(parsed, widget.filter) : []),
    [parsed, widget.filter],
  );

  const rows = useMemo(() => {
    let out = parsed.rows;
    if (filterIdx >= 0 && sel !== ALL) out = out.filter((r) => (r[filterIdx] ?? "").trim() === sel);
    if (sort) {
      const ci = colIdx[sort.col];
      out = out.slice().sort((a, b) => {
        const av = (a[ci] ?? "").trim();
        const bv = (b[ci] ?? "").trim();
        const an = parseFloat(av.replace(/[$,%]/g, ""));
        const bn = parseFloat(bv.replace(/[$,%]/g, ""));
        const cmp = isFinite(an) && isFinite(bn) ? an - bn : av.localeCompare(bv);
        return sort.asc ? cmp : -cmp;
      });
    }
    return out;
  }, [parsed.rows, filterIdx, sel, sort, colIdx]);

  const toggleSort = (col: number) =>
    setSort((s) => (s && s.col === col ? { col, asc: !s.asc } : { col, asc: true }));

  return (
    <div className="w-table">
      <div className="w-chart-head">
        <h3 className="w-chart-title">{widget.title ?? "Data"}</h3>
        {widget.filter && filterOptions.length > 0 && (
          <select className="w-filter" value={sel} onChange={(e) => setSel(e.target.value)} title={`Filter by ${widget.filter}`}>
            <option value={ALL}>All {widget.filter}</option>
            {filterOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="w-table-wrap">
        <table>
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={c + i} onClick={() => toggleSort(i)}>
                  {c}
                  {sort?.col === i ? (sort.asc ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, MAX_ROWS).map((r, ri) => (
              <tr key={ri}>
                {colIdx.map((ci, i) => (
                  <td key={i}>{ci >= 0 ? r[ci] ?? "" : ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_ROWS && <p className="w-note muted small">Showing the first {MAX_ROWS} of {rows.length} rows.</p>}
    </div>
  );
}
