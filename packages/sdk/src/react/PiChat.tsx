/**
 * `<PiChat>` — a batteries-included chat UI for the pi agent in the browser.
 *
 *   import { PiChat } from "wepi/react";
 *   import "wepi/react/PiChat.css"; // optional default styling
 *   <PiChat apiKey={key} files={{ "README.md": "# my project\n" }} />
 *
 * By default it boots a container2wasm bash sandbox (`useC2w`, on by default) so
 * the agent can run shell commands. Pass your own `sandbox` to override, or set
 * `useC2w={false}` for file-tools-only. Built entirely on `usePiChat` +
 * `useC2wSandbox`; drop down to those hooks if you want a custom UI.
 */

import { useState, type KeyboardEvent } from "react";
import type { Sandbox } from "../sandbox.js";
import type { ToolEvent } from "../turn.js";
import { usePiChat } from "./usePiChat.js";
import { useC2wSandbox } from "./useC2wSandbox.js";

export interface PiChatProps {
  /** Provider API key (browser-direct). Required. */
  apiKey: string;
  /** Seed the virtual workspace, keyed by relative path. */
  files?: Record<string, string>;
  /** Model id (default: a current Claude). */
  model?: string;
  /** pi-ai provider id (default: "anthropic"). */
  provider?: string;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Explicit sandbox for the bash tool. Overrides the built-in c2w sandbox. */
  sandbox?: Sandbox;
  /** Boot a container2wasm bash sandbox automatically. Default: true. */
  useC2w?: boolean;
  /** Composer placeholder text. */
  placeholder?: string;
  /** Extra class on the root element. */
  className?: string;
}

/** Render tool args / results compactly for display (ported from the vanilla demo). */
function preview(value: unknown, max = 2000): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value && typeof value === "object" && "command" in value) {
    text = String((value as { command: unknown }).command);
  } else if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    text = (value as { content: { text?: string }[] }).content.map((c) => c?.text ?? "").join("");
  } else {
    text = JSON.stringify(value);
  }
  text = (text ?? "").trimEnd();
  return text.length > max ? text.slice(0, max) + "\n…(truncated)" : text;
}

function ToolLine({ event }: { event: ToolEvent }) {
  if (event.type === "start") {
    return (
      <div className="wepi-tool wepi-tool-start">
        <span className="wepi-tool-name">▶ {event.toolName}</span> {preview(event.args, 200)}
      </div>
    );
  }
  const out = preview(event.result);
  return (
    <div className={"wepi-tool wepi-tool-end" + (event.isError ? " wepi-tool-error" : "")}>
      {out || "(no output)"}
    </div>
  );
}

export function PiChat(props: PiChatProps) {
  const { apiKey, files, model, provider, systemPrompt, sandbox, useC2w, placeholder, className } = props;

  const wantC2w = useC2w !== false && !sandbox;
  const c2w = useC2wSandbox({ enabled: wantC2w });
  const effectiveSandbox = sandbox ?? c2w.sandbox;

  // When we intend to use c2w, hold off creating the Chat until the sandbox
  // instance exists, so the agent is wired with bash (not the NullSandbox fallback).
  const gatedKey = wantC2w && !effectiveSandbox ? "" : apiKey;
  const pi = usePiChat({ apiKey: gatedKey, files, model, provider, systemPrompt, sandbox: effectiveSandbox });

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
    <div className={"wepi-chat" + (className ? " " + className : "")}>
      <div className="wepi-transcript">
        {pi.transcript.length === 0 && (
          <p className="wepi-empty">Ask pi to create/edit files or run shell commands.</p>
        )}
        {pi.transcript.map((entry) => (
          <div key={entry.id} className={"wepi-msg wepi-msg-" + entry.role}>
            <div className="wepi-role">{entry.role === "user" ? "you" : "pi"}</div>
            {entry.tools.length > 0 && (
              <div className="wepi-tools">
                {entry.tools.map((ev, i) => (
                  <ToolLine key={i} event={ev} />
                ))}
              </div>
            )}
            <div className="wepi-text">
              {entry.text}
              {entry.streaming && <span className="wepi-cursor">▍</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="wepi-composer">
        <input
          className="wepi-input"
          value={draft}
          placeholder={placeholder ?? "Ask pi to create a file, or run a shell command…"}
          disabled={!pi.ready || pi.busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {pi.busy ? (
          <button className="wepi-btn" onClick={pi.abort}>Stop</button>
        ) : (
          <button className="wepi-btn" onClick={submit} disabled={!pi.ready || !draft.trim()}>
            Send
          </button>
        )}
      </div>

      {wantC2w && (
        <p className="wepi-status">sandbox: {c2w.status}{c2w.log ? ` — ${c2w.log}` : ""}</p>
      )}
      {!pi.ready && <p className="wepi-status">agent: {gatedKey ? "starting…" : "waiting for sandbox…"}</p>}
    </div>
  );
}
