/**
 * The dashboard as data. A dashboard is a title plus an ordered list of typed
 * widgets; the agent mutates that list one widget at a time through the tools
 * in `agent/tools.ts`, and `Dashboard.tsx` renders it. Keeping the dashboard as
 * plain serialisable state (not generated HTML) is what makes granular
 * add/edit/remove reliable — including from a small on-device model.
 */

import type { Agg, ChartType, Series } from "../data/aggregate";

export type { Agg, ChartType } from "../data/aggregate";

/** One card on the dashboard. Discriminated by `kind`. */
export type Widget =
  | { id: string; kind: "metric"; label: string; column: string; agg: Agg }
  | {
      id: string;
      kind: "chart";
      chartType: ChartType;
      title: string;
      x: string;
      y?: string;
      agg: Agg;
      /** Optional category column offered as an interactive filter. */
      filter?: string;
      /** Pre-computed series (e.g. from the agent's Python) that overrides column-based aggregation. */
      data?: Series;
    }
  | { id: string; kind: "table"; title?: string; columns?: string[]; filter?: string }
  | { id: string; kind: "text"; markdown: string };

export type WidgetKind = Widget["kind"];

export interface DashboardState {
  title: string;
  widgets: Widget[];
}

export const EMPTY_DASHBOARD: DashboardState = { title: "Dashboard", widgets: [] };

/** Parse a persisted `dashboard.json`, tolerating anything malformed. */
export function parseDashboard(json: string): DashboardState | undefined {
  try {
    const obj = JSON.parse(json) as Partial<DashboardState>;
    if (!obj || !Array.isArray(obj.widgets)) return undefined;
    return { title: typeof obj.title === "string" ? obj.title : "Dashboard", widgets: obj.widgets };
  } catch {
    return undefined;
  }
}
