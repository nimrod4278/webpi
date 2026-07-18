/**
 * The agent's dashboard tools — the heart of the showcase.
 *
 * Instead of writing a whole HTML file, the agent edits the dashboard one
 * widget at a time through small, validated tool calls: `add_widget`,
 * `update_widget`, `remove_widget`, plus `query_data` to check real numbers and
 * `list_widgets` to see current state. Each call is a tiny JSON payload, which
 * is what makes this reliable on a 1.5–3B on-device model — and every call
 * mutates the live React dashboard immediately.
 *
 * Column names are validated against the real CSV header; a mismatch throws an
 * error listing the valid columns, so the model self-corrects on its next turn
 * (the same pattern the SDK's tool-call repair loop reinforces). All mutations
 * are mirrored to `dashboard.json` in the workspace for free persistence.
 */

import { Type, type AgentTool, type AgentToolResult, type VirtualFS } from "@wepi/sdk";
import type { ParsedCsv } from "../data/profile";
import { groupAggregate, metricValue, unknownColumns, formatNumber, type Agg, type Filter } from "../data/aggregate";
import { DashboardStore, nextWidgetId } from "../dashboard/DashboardStore";
import type { Widget } from "../dashboard/types";
import { DASHBOARD_JSON_PATH } from "./prompts";

const AggSchema = Type.Union(
  [Type.Literal("sum"), Type.Literal("mean"), Type.Literal("count"), Type.Literal("min"), Type.Literal("max")],
  { description: "Aggregation: sum | mean | count | min | max" },
);
const ChartTypeSchema = Type.Union([Type.Literal("bar"), Type.Literal("line"), Type.Literal("pie")], {
  description: "Chart type: bar | line | pie",
});

// One flat schema covers every widget kind; `execute` enforces the per-kind
// required fields. A flat object is far easier for a small model to emit
// correctly than a nested discriminated union.
const WidgetFields = {
  label: Type.Optional(Type.String({ description: "metric: short label, e.g. 'Total revenue'" })),
  column: Type.Optional(Type.String({ description: "metric: column to aggregate (any column when agg is 'count')" })),
  agg: Type.Optional(AggSchema),
  chartType: Type.Optional(ChartTypeSchema),
  title: Type.Optional(Type.String({ description: "chart/table: title" })),
  x: Type.Optional(Type.String({ description: "chart: x-axis / category column (a date or ordered column for line)" })),
  y: Type.Optional(Type.String({ description: "chart: numeric column to aggregate per x value; omit to count rows" })),
  filter: Type.Optional(Type.String({ description: "chart/table: optional category column for an interactive filter" })),
  columns: Type.Optional(Type.Array(Type.String(), { description: "table: columns to show; omit for all columns" })),
  markdown: Type.Optional(Type.String({ description: "text: a short written insight or note" })),
  dataLabels: Type.Optional(Type.Array(Type.String(), { description: "chart (advanced): explicit x labels, e.g. from your own Python; pair with dataValues" })),
  dataValues: Type.Optional(Type.Array(Type.Number(), { description: "chart (advanced): explicit y values matching dataLabels" })),
};

const AddWidgetSchema = Type.Object({
  kind: Type.Union([Type.Literal("metric"), Type.Literal("chart"), Type.Literal("table"), Type.Literal("text")], {
    description: "Widget kind: metric | chart | table | text",
  }),
  ...WidgetFields,
});
const UpdateWidgetSchema = Type.Object({
  id: Type.String({ description: "id of the widget to change (from list_widgets or a previous add_widget)" }),
  ...WidgetFields,
});

type WidgetArgs = {
  kind?: Widget["kind"];
  label?: string;
  column?: string;
  agg?: Agg;
  chartType?: "bar" | "line" | "pie";
  title?: string;
  x?: string;
  y?: string;
  filter?: string;
  columns?: string[];
  markdown?: string;
  dataLabels?: string[];
  dataValues?: number[];
};

const text = (t: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: t }], details: undefined });

function describeWidget(w: Widget): string {
  switch (w.kind) {
    case "metric":
      return `${w.id}: metric "${w.label}" (${w.agg} of ${w.column})`;
    case "chart":
      return `${w.id}: ${w.chartType} chart "${w.title}" (${w.y ? `${w.agg} of ${w.y}` : "count"} by ${w.x})`;
    case "table":
      return `${w.id}: table "${w.title ?? "Data"}"`;
    case "text":
      return `${w.id}: text note`;
  }
}

function stateSummary(store: DashboardStore): string {
  const { widgets } = store.getSnapshot();
  if (widgets.length === 0) return "The dashboard is now empty.";
  return `Dashboard now has ${widgets.length} widget(s):\n` + widgets.map((w) => "- " + describeWidget(w)).join("\n");
}

/** Build a widget from tool args, validating required fields + column names. */
function buildWidget(kind: Widget["kind"], a: WidgetArgs, parsed: ParsedCsv, id: string): Widget {
  const check = (...cols: (string | undefined)[]) => {
    const bad = unknownColumns(parsed, cols);
    if (bad.length > 0) {
      throw new Error(
        `Unknown column(s): ${bad.join(", ")}. Valid columns are: ${parsed.header.join(", ")}. ` +
          "Use exact column names from that list.",
      );
    }
  };

  if (kind === "metric") {
    const agg: Agg = a.agg ?? (a.column ? "sum" : "count");
    const column = a.column ?? parsed.header[0] ?? "";
    if (agg !== "count") check(column);
    return { id, kind: "metric", label: a.label ?? `${agg} of ${column}`, column, agg };
  }
  if (kind === "chart") {
    if (!a.x) throw new Error("A chart needs `x` (the category or date column for the x-axis).");
    check(a.x, a.y, a.filter);
    const chartType = a.chartType ?? "bar";
    const agg: Agg = a.agg ?? (a.y ? "sum" : "count");
    const data =
      a.dataLabels && a.dataValues ? { labels: a.dataLabels, values: a.dataValues } : undefined;
    return {
      id,
      kind: "chart",
      chartType,
      title: a.title ?? (a.y ? `${a.y} by ${a.x}` : `Rows by ${a.x}`),
      x: a.x,
      y: a.y,
      agg,
      filter: a.filter,
      data,
    };
  }
  if (kind === "table") {
    if (a.columns) check(...a.columns);
    check(a.filter);
    return { id, kind: "table", title: a.title, columns: a.columns, filter: a.filter };
  }
  // text
  if (!a.markdown) throw new Error("A text widget needs `markdown` (the note to display).");
  return { id, kind: "text", markdown: a.markdown };
}

/**
 * Build the dashboard tool set, bound to a store, the workspace fs, and the data.
 * `minimal` (for small on-device models) drops the two lowest-value tools —
 * `list_widgets` (every mutation already echoes the widget list) and
 * `set_dashboard_title` — to keep the model focused on add/update/remove/query.
 */
export function widgetTools(
  store: DashboardStore,
  fs: VirtualFS,
  parsed: ParsedCsv,
  opts: { minimal?: boolean } = {},
): AgentTool[] {
  // Mirror every mutation into the workspace so it persists with the chat.
  store.bind((state) => fs.write(DASHBOARD_JSON_PATH, JSON.stringify(state, null, 2)));

  const addWidget: AgentTool = {
    name: "add_widget",
    label: "Add widget",
    description:
      "Add one widget to the dashboard. kind='metric' (label, column, agg), 'chart' (chartType, x, optional y, agg), " +
      "'table' (optional columns), or 'text' (markdown insight). Returns the new widget id.",
    parameters: AddWidgetSchema,
    execute: async (_id, args): Promise<AgentToolResult<unknown>> => {
      const a = args as WidgetArgs & { kind: Widget["kind"] };
      const widget = buildWidget(a.kind, a, parsed, nextWidgetId());
      store.add(widget);
      return text(`Added ${describeWidget(widget)}.\n${stateSummary(store)}`);
    },
  };

  const updateWidget: AgentTool = {
    name: "update_widget",
    label: "Update widget",
    description:
      "Change an existing widget by id. Pass only the fields to change (e.g. chartType='line', or a new title/column). " +
      "The widget keeps its kind.",
    parameters: UpdateWidgetSchema,
    execute: async (_id, args): Promise<AgentToolResult<unknown>> => {
      const a = args as WidgetArgs & { id: string };
      const existing = store.getSnapshot().widgets.find((w) => w.id === a.id);
      if (!existing) {
        throw new Error(`No widget with id "${a.id}". Current widgets:\n${stateSummary(store)}`);
      }
      // Re-validate the merged widget so bad columns are caught here too.
      const merged = { ...existing, ...stripUndefined(a) } as WidgetArgs;
      const rebuilt = buildWidget(existing.kind, merged, parsed, existing.id);
      store.update(existing.id, rebuilt);
      return text(`Updated ${describeWidget(rebuilt)}.`);
    },
  };

  const removeWidget: AgentTool = {
    name: "remove_widget",
    label: "Remove widget",
    description: "Remove a widget from the dashboard by id.",
    parameters: Type.Object({ id: Type.String({ description: "id of the widget to remove (see list_widgets)" }) }),
    execute: async (_id, args): Promise<AgentToolResult<unknown>> => {
      const { id } = args as { id: string };
      if (!store.remove(id)) throw new Error(`No widget with id "${id}". Current widgets:\n${stateSummary(store)}`);
      return text(`Removed widget ${id}.\n${stateSummary(store)}`);
    },
  };

  const listWidgets: AgentTool = {
    name: "list_widgets",
    label: "List widgets",
    description: "List the widgets currently on the dashboard, with their ids.",
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<unknown>> => text(stateSummary(store)),
  };

  const setTitle: AgentTool = {
    name: "set_dashboard_title",
    label: "Set title",
    description: "Set the dashboard's title.",
    parameters: Type.Object({ title: Type.String({ description: "the new dashboard title" }) }),
    execute: async (_id, args): Promise<AgentToolResult<unknown>> => {
      const { title } = args as { title: string };
      store.setTitle(title);
      return text(`Dashboard title set to "${title}".`);
    },
  };

  const queryData: AgentTool = {
    name: "query_data",
    label: "Query data",
    description:
      "Compute exact numbers from the dataset before you build a widget. Aggregate one column, optionally grouped by " +
      "a category/date column. Use this to find what's interesting — never guess numbers.",
    parameters: Type.Object({
      agg: AggSchema,
      column: Type.Optional(Type.String({ description: "numeric column to aggregate; omit when agg is 'count'" })),
      groupBy: Type.Optional(Type.String({ description: "category/date column to group by; omit for a single overall value" })),
      filterColumn: Type.Optional(Type.String({ description: "restrict to rows where this column equals filterValue" })),
      filterValue: Type.Optional(Type.String({ description: "the value to keep in filterColumn" })),
      limit: Type.Optional(Type.Integer({ description: "max groups to return (default 15)" })),
    }),
    execute: async (_id, args): Promise<AgentToolResult<unknown>> => {
      const a = args as { agg: Agg; column?: string; groupBy?: string; filterColumn?: string; filterValue?: string; limit?: number };
      const bad = unknownColumns(parsed, [a.column, a.groupBy, a.filterColumn]);
      if (bad.length > 0) {
        throw new Error(`Unknown column(s): ${bad.join(", ")}. Valid columns are: ${parsed.header.join(", ")}.`);
      }
      const filter: Filter | undefined =
        a.filterColumn && a.filterValue ? { column: a.filterColumn, value: a.filterValue } : undefined;

      if (!a.groupBy) {
        const v = metricValue(parsed, a.column ?? parsed.header[0] ?? "", a.agg, filter);
        return text(`${a.agg}${a.column ? ` of ${a.column}` : " of rows"}${filter ? ` where ${filter.column}=${filter.value}` : ""} = ${formatNumber(v)}`);
      }
      const limit = a.limit ?? 15;
      const rows = groupAggregate(parsed, a.groupBy, a.column, a.agg, filter)
        .sort((x, y) => y[1] - x[1])
        .slice(0, limit);
      const label = a.column ? `${a.agg} of ${a.column}` : "count";
      const body = rows.map(([k, v]) => `  ${k}: ${formatNumber(v)}`).join("\n");
      return text(`${label} by ${a.groupBy}${filter ? ` (where ${filter.column}=${filter.value})` : ""}:\n${body}`);
    },
  };

  return opts.minimal
    ? [queryData, addWidget, updateWidget, removeWidget]
    : [queryData, addWidget, updateWidget, removeWidget, listWidgets, setTitle];
}

/** Drop keys whose value is undefined so a patch doesn't clobber set fields. */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
