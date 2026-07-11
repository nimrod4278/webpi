/**
 * A bar / line / pie chart, rendered with react-chartjs-2. The series is
 * computed live from the dataset (or taken from the agent's precomputed
 * `data`). If the widget declares a filter column, a dropdown lets the user
 * slice the chart client-side.
 */

import { useMemo, useState } from "react";
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Bar, Line, Pie } from "react-chartjs-2";
import type { ParsedCsv } from "../../data/profile";
import { chartSeries, distinctTop, type Filter } from "../../data/aggregate";
import type { Widget } from "../types";

ChartJS.register(CategoryScale, LinearScale, BarElement, PointElement, LineElement, ArcElement, Tooltip, Legend);

const PALETTE = ["#4f46e5", "#f59f4f", "#059669", "#e0565b", "#9b6df5", "#38b6c9", "#c9a038", "#7a8699", "#d76fb1", "#5b8a3c", "#b05c3b", "#4d5bc9"];

const ALL = "__all__";

export function ChartWidget({ widget, parsed }: { widget: Extract<Widget, { kind: "chart" }>; parsed: ParsedCsv }) {
  const [sel, setSel] = useState(ALL);
  const filterOptions = useMemo(
    () => (widget.filter ? distinctTop(parsed, widget.filter) : []),
    [parsed, widget.filter],
  );

  const series = useMemo(() => {
    if (widget.data) return widget.data;
    const filter: Filter | undefined =
      widget.filter && sel !== ALL ? { column: widget.filter, value: sel } : undefined;
    return chartSeries(parsed, widget, filter);
  }, [parsed, widget, sel]);

  const multi = widget.chartType === "pie";
  const data = {
    labels: series.labels,
    datasets: [
      {
        data: series.values,
        backgroundColor: multi ? PALETTE : PALETTE[0],
        borderColor: PALETTE[0],
        fill: false,
        tension: 0.2,
      },
    ],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: multi } },
    scales: multi ? {} : { y: { beginAtZero: true } },
  } as const;

  const Chart = widget.chartType === "line" ? Line : widget.chartType === "pie" ? Pie : Bar;

  return (
    <div className="w-chart">
      <div className="w-chart-head">
        <h3 className="w-chart-title">{widget.title}</h3>
        {widget.filter && filterOptions.length > 0 && !widget.data && (
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
      <div className="w-chart-box">
        <Chart data={data} options={options} />
      </div>
    </div>
  );
}
