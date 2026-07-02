/**
 * Build-your-own-UI demo: the same agent as <PiChat>, but wired by hand from the
 * `usePiChat` + `useC2wSandbox` hooks so you can see exactly what the component
 * does under the hood. Source of the hooks: packages/sdk/src/react/.
 */

import { useState, type KeyboardEvent } from "react";
import { usePiChat, useC2wSandbox } from "wepi/react";
import type { ModelChoice } from "./App";

export function CustomChat({ choice }: { choice: ModelChoice }) {
  // 1. Boot the container2wasm bash sandbox (status drives the line at the bottom).
  const c2w = useC2wSandbox();

  // 2. Create the agent, wired to that sandbox and the chosen model (cloud or
  //    local). Hold creation back until the sandbox exists so bash is available
  //    from the first turn — gate on the credential/provider the choice carries.
  const gated = c2w.sandbox
    ? { provider: choice.provider, model: choice.model, apiKey: choice.apiKey }
    : { apiKey: "" };
  const pi = usePiChat({
    ...gated,
    sandbox: c2w.sandbox,
    files: { "notes.txt": "hello from the hooks demo\n" },
  });

  const [draft, setDraft] = useState("");
  const submit = () => {
    if (!draft.trim() || pi.busy) return;
    void pi.send(draft);
    setDraft("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div
        style={{
          background: "#f5f5f5",
          border: "1px solid #e2e2e2",
          borderRadius: 8,
          padding: "1rem",
          minHeight: "12rem",
          maxHeight: "60vh",
          overflowY: "auto",
        }}
      >
        {pi.transcript.length === 0 && <p style={{ color: "#888", margin: 0 }}>Say hello to pi…</p>}
        {pi.transcript.map((entry) => (
          <div key={entry.id} style={{ marginBottom: "1rem" }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", color: entry.role === "user" ? "#4f46e5" : "#888" }}>
              {entry.role === "user" ? "you" : "pi"}
            </div>
            {entry.tools.length > 0 && (
              <div style={{ borderLeft: "2px solid #e2e2e2", paddingLeft: "0.6rem", fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#555" }}>
                {entry.tools.map((ev, i) => (
                  <div key={i} style={{ whiteSpace: "pre-wrap" }}>
                    {ev.type === "start" ? `▶ ${ev.toolName}` : "  ↳ done"}
                  </div>
                ))}
              </div>
            )}
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {entry.text}
              {entry.streaming && "▍"}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <input
          value={draft}
          placeholder="Ask pi anything…"
          disabled={!pi.ready || pi.busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          style={{ flex: 1, font: "inherit", padding: "0.5rem", border: "1px solid #e2e2e2", borderRadius: 6 }}
        />
        <button
          onClick={pi.busy ? pi.abort : submit}
          disabled={!pi.ready && !pi.busy}
          style={{ font: "inherit", padding: "0.5rem 1rem", borderRadius: 6, border: "none", background: "#4f46e5", color: "#fff", cursor: "pointer" }}
        >
          {pi.busy ? "Stop" : "Send"}
        </button>
      </div>

      <p style={{ fontSize: 12, color: "#888", margin: 0 }}>
        sandbox: {c2w.status}
        {c2w.log ? ` — ${c2w.log}` : ""}
        {!pi.ready && " · agent starting…"}
      </p>
    </div>
  );
}
