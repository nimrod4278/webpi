/**
 * Dashboard — the live artifact pane. Subscribes to the DashboardStore via
 * useSyncExternalStore and renders the widgets as a responsive card grid; when
 * the agent adds/edits/removes a widget, the store notifies and this re-renders
 * instantly. Metrics span one column, charts/tables/text can span wider. Each
 * card carries a remove control so the user can edit too. "Download" exports the
 * current dashboard to a standalone HTML file.
 */

import { useSyncExternalStore } from "react";
import type { ParsedCsv } from "../data/profile";
import { exportDashboardHtml } from "../agent/defaults";
import type { DashboardStore } from "./DashboardStore";
import type { Widget } from "./types";
import { MetricWidget } from "./widgets/MetricWidget";
import { ChartWidget } from "./widgets/ChartWidget";
import { TableWidget } from "./widgets/TableWidget";
import { TextWidget } from "./widgets/TextWidget";

function WidgetBody({ widget, parsed }: { widget: Widget; parsed: ParsedCsv }) {
  switch (widget.kind) {
    case "metric":
      return <MetricWidget widget={widget} parsed={parsed} />;
    case "chart":
      return <ChartWidget widget={widget} parsed={parsed} />;
    case "table":
      return <TableWidget widget={widget} parsed={parsed} />;
    case "text":
      return <TextWidget widget={widget} />;
  }
}

/** Column span per widget kind — metrics are compact, the rest breathe. */
function spanClass(kind: Widget["kind"]): string {
  if (kind === "metric") return "w-card-metric";
  if (kind === "table") return "w-card-wide";
  return "w-card-chart";
}

export function Dashboard({
  store,
  parsed,
  csv,
  busy,
}: {
  store: DashboardStore;
  parsed: ParsedCsv;
  csv: string;
  busy: boolean;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const download = () => {
    const blob = new Blob([exportDashboardHtml(state, csv)], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (state.title || "dashboard").replace(/[^\w-]+/g, "-").toLowerCase() + ".html";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="dash">
      <div className="dash-bar">
        <span className="dash-title">{state.title}</span>
        <button className="btn-ghost" onClick={download} disabled={state.widgets.length === 0}>
          Download
        </button>
      </div>

      {state.widgets.length === 0 ? (
        <div className="dash-empty">
          <div className="dash-empty-icon">📊</div>
          <p>{busy ? "Building your dashboard…" : "Your dashboard will appear here."}</p>
          <p className="muted small">The agent inspects your data, finds insights, then adds widgets live.</p>
        </div>
      ) : (
        <div className="dash-grid">
          {state.widgets.map((w) => (
            <div key={w.id} className={"w-card " + spanClass(w.kind)}>
              <button className="w-remove" title="Remove widget" onClick={() => store.remove(w.id)}>
                ✕
              </button>
              <WidgetBody widget={w} parsed={parsed} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
