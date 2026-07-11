/**
 * ChatPanel — the conversation half of the workspace. A thin, presentational
 * wrapper over the `usePiChat` transcript: it renders user/assistant turns,
 * collapses tool activity into a compact "running Python…" style line, and
 * owns the composer. All chat state lives in the parent's `usePiChat` result,
 * passed in as `pi`.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { UsePiChatResult } from "wepi/react";

/** Friendlier labels for the agent's tools than the raw tool name. */
function toolLabel(name: string): string {
  switch (name) {
    case "bash":
      return "running code";
    case "write":
      return "writing dashboard";
    case "edit":
      return "editing dashboard";
    case "read":
      return "reading data";
    case "list":
    case "search":
      return "inspecting data";
    default:
      return name;
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
                {entry.tools.map((ev, i) =>
                  ev.type === "start" ? (
                    <div key={i} className="tool-line">
                      <span className="spinner-dot" /> {toolLabel(ev.toolName)}…
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
          placeholder={disabled ? "Starting…" : "Ask for a change — e.g. “add a filter by region”"}
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
