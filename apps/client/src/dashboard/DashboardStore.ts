/**
 * DashboardStore — the single in-memory source of truth for what the dashboard
 * shows. The agent's tools mutate it (add/update/remove); React renders from it
 * via `useSyncExternalStore`. Every mutation also mirrors the whole state to
 * `dashboard.json` in the agent's VirtualFS, so the dashboard rides the SDK's
 * existing per-turn snapshot persistence for free and rehydrates on reload —
 * no separate storage layer.
 *
 * State is treated as immutable: each mutation swaps in a new object so
 * `useSyncExternalStore`'s referential check fires exactly once per change.
 */

import { EMPTY_DASHBOARD, type DashboardState, type Widget } from "./types";

let counter = 0;
/** Short, stable-enough widget id. */
export function nextWidgetId(): string {
  return `w${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export class DashboardStore {
  private state: DashboardState = EMPTY_DASHBOARD;
  private readonly listeners = new Set<() => void>();
  /** Set by the tools factory to persist changes into the VirtualFS. */
  private onCommit?: (state: DashboardState) => void;

  // ── useSyncExternalStore contract ──
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): DashboardState => this.state;

  /** Bind the VirtualFS mirror. Does not write until the next mutation/commit. */
  bind(onCommit: (state: DashboardState) => void): void {
    this.onCommit = onCommit;
  }

  /** Push the current state to the mirror (e.g. after re-binding a fresh fs). */
  commit(): void {
    this.onCommit?.(this.state);
  }

  setTitle(title: string): void {
    this.next({ ...this.state, title });
  }

  add(widget: Widget): string {
    this.next({ ...this.state, widgets: [...this.state.widgets, widget] });
    return widget.id;
  }

  /** Merge a partial patch into a widget by id; returns false if not found. */
  update(id: string, patch: Partial<Widget>): boolean {
    let found = false;
    const widgets = this.state.widgets.map((w) => {
      if (w.id !== id) return w;
      found = true;
      return { ...w, ...patch, id: w.id, kind: w.kind } as Widget;
    });
    if (found) this.next({ ...this.state, widgets });
    return found;
  }

  remove(id: string): boolean {
    const widgets = this.state.widgets.filter((w) => w.id !== id);
    if (widgets.length === this.state.widgets.length) return false;
    this.next({ ...this.state, widgets });
    return true;
  }

  /** Replace the whole dashboard (hydration / fallback). */
  setAll(state: DashboardState): void {
    this.next(state);
  }

  private next(state: DashboardState): void {
    this.state = state;
    this.onCommit?.(state);
    for (const l of this.listeners) l();
  }
}
