/** A single headline number, computed live from the dataset. */

import type { ParsedCsv } from "../../data/profile";
import { formatNumber, metricValue } from "../../data/aggregate";
import type { Widget } from "../types";

export function MetricWidget({ widget, parsed }: { widget: Extract<Widget, { kind: "metric" }>; parsed: ParsedCsv }) {
  const value = metricValue(parsed, widget.column, widget.agg);
  return (
    <div className="w-metric">
      <span className="w-metric-label">{widget.label}</span>
      <b className="w-metric-value">{formatNumber(value)}</b>
    </div>
  );
}
