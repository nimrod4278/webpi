/**
 * wepi-client — the canonical example of consuming the `wepi` SDK.
 *
 * Two demos, both gated behind an API key:
 *   1. <PiChat> — the batteries-included component from `wepi/react`.
 *   2. A hand-rolled UI built directly on the `usePiChat` + `useC2wSandbox`
 *      hooks, to show how to drive the agent yourself.
 */

import { useState } from "react";
import { PiChat } from "wepi/react";
import "wepi/react/PiChat.css";
import { CustomChat } from "./CustomChat";

const SEED_FILES = { "README.md": "# my project\n" };

type Demo = "component" | "hooks";

export function App() {
  const [key, setKey] = useState("");
  const [submittedKey, setSubmittedKey] = useState("");
  const [demo, setDemo] = useState<Demo>("component");

  return (
    <main style={{ font: "14px/1.5 system-ui, sans-serif", maxWidth: 760, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>wepi</h1>
      <p style={{ color: "#888", fontSize: 12 }}>
        The pi coding agent, native in your browser. Files live in a sandboxed virtual workspace;{" "}
        <code>bash</code> runs in a container2wasm Alpine sandbox. Powered by the <code>wepi</code> SDK.
      </p>

      {!submittedKey ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) setSubmittedKey(key.trim());
          }}
        >
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Anthropic API key (sk-ant-…)"
            size={48}
            style={{ font: "inherit", padding: "0.5rem" }}
          />
          <button type="submit" style={{ font: "inherit", padding: "0.5rem 1rem", marginLeft: "0.5rem" }}>
            Start
          </button>
        </form>
      ) : (
        <>
          <nav style={{ display: "flex", gap: "0.5rem", margin: "1rem 0" }}>
            <TabButton active={demo === "component"} onClick={() => setDemo("component")}>
              &lt;PiChat&gt; component
            </TabButton>
            <TabButton active={demo === "hooks"} onClick={() => setDemo("hooks")}>
              usePiChat hook
            </TabButton>
          </nav>

          {demo === "component" ? (
            <PiChat apiKey={submittedKey} files={SEED_FILES} />
          ) : (
            <CustomChat apiKey={submittedKey} />
          )}
        </>
      )}
    </main>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        font: "inherit",
        padding: "0.4rem 0.8rem",
        borderRadius: 6,
        border: "1px solid #e2e2e2",
        background: active ? "#4f46e5" : "#fff",
        color: active ? "#fff" : "#1a1a1a",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
