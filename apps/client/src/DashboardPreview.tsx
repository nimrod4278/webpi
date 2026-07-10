/**
 * DashboardPreview — the live artifact pane.
 *
 * Watches the agent's virtual workspace (`chat.fs.onChange`) for the most
 * recently written `.html` file and renders it in a sandboxed iframe via
 * `srcdoc`. Because the agent's `write` tool mutates the main-thread VirtualFS
 * synchronously, the dashboard streams in as the agent builds it — no polling.
 * The iframe is `allow-scripts` (Chart.js + interactivity) but same-origin
 * access is withheld, so a generated page can't reach the app or its storage.
 */

import { useEffect, useMemo, useState } from "react";
import type { Chat } from "wepi";

const isHtml = (path: string) => path.toLowerCase().endsWith(".html");

/** Pick the newest .html file from a workspace snapshot, if any. */
function pickHtml(files: Record<string, string>): { path: string; html: string } | undefined {
  const htmlPaths = Object.keys(files).filter(isHtml);
  if (htmlPaths.length === 0) return undefined;
  // Prefer a file literally named dashboard.html; else the first html file.
  const path = htmlPaths.find((p) => p.toLowerCase().endsWith("dashboard.html")) ?? htmlPaths[0];
  return { path, html: files[path] };
}

export function DashboardPreview({ chat, busy }: { chat: Chat | undefined; busy: boolean }) {
  const [artifact, setArtifact] = useState<{ path: string; html: string } | undefined>();

  useEffect(() => {
    if (!chat) return;
    // Seed from any already-present artifact (e.g. a restored/persisted session).
    setArtifact(pickHtml(chat.files()));
    const unsub = chat.fs.onChange((change) => {
      if (isHtml(change.path)) setArtifact({ path: change.path, html: change.content });
    });
    return unsub;
  }, [chat]);

  const download = () => {
    if (!artifact) return;
    const blob = new Blob([artifact.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = artifact.path.split("/").pop() || "dashboard.html";
    a.click();
    URL.revokeObjectURL(url);
  };

  const openInTab = () => {
    if (!artifact) return;
    const blob = new Blob([artifact.html], { type: "text/html" });
    window.open(URL.createObjectURL(blob), "_blank", "noopener");
  };

  // Remount the iframe when the html changes so scripts re-run cleanly.
  const iframeKey = useMemo(() => (artifact ? artifact.html.length + ":" + artifact.path : "empty"), [artifact]);

  return (
    <section className="preview">
      <div className="preview-bar">
        <span className="preview-title">{artifact ? artifact.path : "Dashboard"}</span>
        <span className="preview-actions">
          <button className="btn-ghost" onClick={openInTab} disabled={!artifact}>
            Open in tab
          </button>
          <button className="btn-primary" onClick={download} disabled={!artifact}>
            Download .html
          </button>
        </span>
      </div>
      <div className="preview-body">
        {artifact ? (
          <iframe
            key={iframeKey}
            className="preview-frame"
            title="dashboard"
            sandbox="allow-scripts allow-popups"
            srcDoc={artifact.html}
          />
        ) : (
          <div className="preview-empty">
            <div className="preview-empty-icon">📊</div>
            <p>{busy ? "Building your dashboard…" : "Your interactive dashboard will appear here."}</p>
            <p className="muted small">The agent inspects your data, finds insights, then renders it live.</p>
          </div>
        )}
      </div>
    </section>
  );
}
