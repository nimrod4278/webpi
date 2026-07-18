/**
 * ChatPanel — the conversation half of the workspace. A thin, presentational
 * wrapper over the `usePiChat` transcript: it renders user/assistant turns and
 * turns each tool call into a friendly activity chip (e.g. "Added chart ·
 * Revenue by region"), so the user can watch the agent build the dashboard. All
 * chat state lives in the parent's `usePiChat` result, passed in as `pi`.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { UsePiChatResult } from "@wepi/sdk/react";
import type { ToolEvent } from "@wepi/sdk";

/** Turn a tool-start event into an icon + human phrase, with a short detail. */
function describeTool(toolName: string, args: unknown): { icon: string; text: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  switch (toolName) {
    case "query_data":
      return { icon: "🔎", text: "Analyzing" + (str(a.groupBy) ? ` by ${a.groupBy}` : str(a.column) ? ` ${a.column}` : " data") };
    case "add_widget": {
      const detail = str(a.title) ?? str(a.label) ?? str(a.kind) ?? "";
      return { icon: "➕", text: `Added ${str(a.kind) ?? "widget"}${detail && detail !== str(a.kind) ? ` · ${detail}` : ""}` };
    }
    case "update_widget":
      return { icon: "✏️", text: "Updated widget" };
    case "remove_widget":
      return { icon: "🗑️", text: "Removed widget" };
    case "list_widgets":
      return { icon: "📋", text: "Reviewing dashboard" };
    case "set_dashboard_title":
      return { icon: "🏷️", text: `Titled “${str(a.title) ?? "dashboard"}”` };
    case "bash":
      return { icon: "⚙️", text: "Running code" };
    case "write":
      return { icon: "📝", text: "Writing file" };
    case "edit":
      return { icon: "✏️", text: "Editing file" };
    case "read":
      return { icon: "📖", text: "Reading data" };
    case "ls":
    case "grep":
      return { icon: "🔍", text: "Inspecting files" };
    default:
      return { icon: "•", text: toolName };
  }
}

export function ChatPanel({ pi, disabled }: { pi: UsePiChatResult; disabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the transcript pinned to the latest as it streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [pi.transcript]);

  const submit = () => {
    if (!draft.trim() || pi.busy || disabled) return;
    void pi.send(draft);
    setDraft("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit();
  };

  return (
    <section className="chat">
      <div className="transcript" ref={scrollRef}>
        {pi.transcript.length === 0 && (
          <p className="muted">
            {disabled ? "Getting your workspace ready…" : "Analysing your data and building a dashboard…"}
          </p>
        )}
        {pi.transcript.map((entry) => (
          <div key={entry.id} className={"msg msg-" + entry.role}>
            <div className="msg-role">{entry.role === "user" ? "you" : "insight"}</div>
            {entry.tools.length > 0 && (
              <div className="tools">
                {entry.tools.map((ev: ToolEvent, i) =>
                  ev.type === "start" ? (
                    <div key={i} className="tool-chip">
                      <span className="tool-chip-icon">{describeTool(ev.toolName, ev.args).icon}</span>
                      {describeTool(ev.toolName, ev.args).text}
                    </div>
                  ) : null,
                )}
              </div>
            )}
            {entry.text && (
              <div className="msg-text">
                {entry.text}
                {entry.streaming && <span className="cursor">▍</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      {pi.contextPct >= 0.75 && (
        <div className="ctx-banner">
          <span>
            {pi.contextPct >= 0.95
              ? "The model's memory is full — replies now only see recent messages."
              : "The model's memory is nearly full — older messages will be trimmed."}
          </span>
          <button className="btn-ghost" onClick={pi.reset} disabled={pi.busy}>
            Start fresh chat
          </button>
        </div>
      )}

      <div className="composer">
        <input
          value={draft}
          placeholder={disabled ? "Starting…" : "Ask for a change — e.g. “add a pie of sales by region”"}
          disabled={disabled || !pi.ready}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {pi.busy ? (
          <button className="btn-primary" onClick={pi.abort}>
            Stop
          </button>
        ) : (
          <button className="btn-primary" onClick={submit} disabled={disabled || !pi.ready || !draft.trim()}>
            Send
          </button>
        )}
      </div>
    </section>
  );
}
