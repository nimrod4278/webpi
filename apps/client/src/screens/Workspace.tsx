/**
 * Workspace — the product's main screen for one dataset.
 *
 * Boots the c2w bash sandbox (for real Python analysis), creates the pi agent
 * wired to the chosen model + the analyst system prompt, seeds the CSV into the
 * workspace, and persists everything per-dataset so a reload resumes exactly.
 * Layout is two panes: the conversation (ChatPanel) and the live artifact
 * (DashboardPreview). Once the agent is ready it kicks off the first analysis
 * automatically — the "drop a CSV, get a dashboard" moment.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { usePiChat, useC2wSandbox } from "wepi/react";
import type { VirtualFS } from "wepi";
import { ChatPanel } from "./ChatPanel";
import { DashboardPreview } from "./DashboardPreview";
import { FileExplorer } from "./FileExplorer";
import { analystSystemPrompt, localAnalystSystemPrompt, DASHBOARD_PATH, DATA_PATH } from "./prompts";
import { formatProfile, parseCsv, profileCsv } from "./profile";
import { createSaveDashboardSpecTool, defaultSpecFromProfile, renderDashboardHtml } from "./dashboardSpec";
import { isGpuLostError } from "./gpuCaps";
import type { Dataset } from "./lib";
import type { ModelChoice } from "./ModelSetup";

const KICKOFF = "Analyse data.csv and build me an interactive dashboard of the most interesting findings.";

export function Workspace({
  dataset,
  choice,
  onChangeDataset,
  onChangeModel,
}: {
  dataset: Dataset;
  choice: ModelChoice;
  onChangeDataset: () => void;
  onChangeModel: () => void;
}) {
  // Right pane can show the live dashboard or the agent's whole filesystem.
  const [tab, setTab] = useState<"dashboard" | "files">("dashboard");
  const [fileCount, setFileCount] = useState(0);

  // 1. Boot the sandbox that backs the bash tool (Python lives here).
  const c2w = useC2wSandbox();

  // Small on-device models can't drive pandas or hand-write dashboard HTML, so
  // the local path pre-computes the data profile deterministically and swaps
  // the whole coding toolset for one spec-shaped tool (see dashboardSpec.ts).
  const profile = useMemo(() => profileCsv(dataset.text), [dataset]);
  const localTools = useMemo(
    () => (fs: VirtualFS) => [createSaveDashboardSpecTool(fs, () => dataset.text)],
    [dataset],
  );

  // 2. Create the agent once the sandbox exists, wired to the chosen model.
  const gated = c2w.sandbox
    ? { provider: choice.provider, model: choice.model, apiKey: choice.apiKey }
    : { apiKey: "" };
  const pi = usePiChat({
    ...gated,
    sandbox: c2w.sandbox,
    enabled: !!c2w.sandbox,
    systemPrompt: choice.local ? localAnalystSystemPrompt(formatProfile(profile)) : analystSystemPrompt(),
    files: { [DATA_PATH]: dataset.text },
    persist: dataset.id,
    ...(choice.local ? { defaultTools: false as const, tools: localTools } : {}),
  });

  // 3. Auto-start the first analysis once everything is warm — but only for a
  //    brand-new session (no restored conversation) with actual data present.
  const kickedRef = useRef(false);
  useEffect(() => {
    if (kickedRef.current) return;
    const chat = pi.chat;
    if (!pi.ready || !c2w.ready || !chat) return;
    const hasHistory = chat.messages.length > 0;
    const hasData = (chat.files()[DATA_PATH] ?? "").trim().length > 0;
    if (hasHistory || !hasData) {
      kickedRef.current = true; // resumed session or empty recent — wait for the user
      return;
    }
    kickedRef.current = true;
    void pi.send(KICKOFF);
  }, [pi.ready, c2w.ready, pi.chat, pi]);

  // 4. Safety net for local models: if a turn ends and no dashboard exists
  //    (the model exhausted its tool-call retries or never called the tool),
  //    render a starter dashboard from the deterministic profile — the user
  //    always gets something, with the model's chat insights alongside.
  const [usedFallback, setUsedFallback] = useState(false);
  const fallbackRef = useRef(false);
  useEffect(() => {
    const chat = pi.chat;
    if (!chat || !choice.local) return;
    const unsub = chat.subscribe((event) => {
      if (event.type !== "agent_end" || fallbackRef.current) return;
      fallbackRef.current = true; // one check per session: succeed or fall back
      if ((chat.files()[DASHBOARD_PATH] ?? "").trim()) return;
      chat.fs.write(DASHBOARD_PATH, renderDashboardHtml(defaultSpecFromProfile(profile), parseCsv(dataset.text)));
      setUsedFallback(true);
    });
    return unsub;
  }, [pi.chat, choice.local, profile, dataset]);

  // Keep the Files-tab badge count in sync with the agent's workspace.
  const chat = pi.chat;
  useEffect(() => {
    if (!chat) return;
    setFileCount(Object.keys(chat.files()).length);
    const unsub = chat.fs.onChange(() => setFileCount(Object.keys(chat.files()).length));
    return unsub;
  }, [chat]);

  const notReady = !pi.ready || !c2w.ready;
  const metrics = pi.chat?.metrics;

  // A WebLLM model too heavy for this GPU loses the device mid-run. WebLLM's
  // engine is unrecoverable after that (it must be recreated), so offer the one
  // real fix: switch to a lighter model. onChangeModel disposes the dead engine.
  const gpuLost = choice.local && isGpuLostError(pi.error);

  return (
    <div className="workspace">
      <header className="ws-head">
        <div className="ws-head-left">
          <button className="btn-ghost" onClick={onChangeDataset}>
            ← Datasets
          </button>
          <span className="ws-dataset" title={dataset.name}>
            {dataset.name}
          </span>
        </div>
        <div className="ws-head-right">
          {choice.local ? (
            <span className="badge badge-private" title="Inference runs on your device; nothing is sent anywhere.">
              🔒 On-device · nothing sent
            </span>
          ) : (
            <span className="badge" title="Analysis is sent to the cloud provider you chose.">
              ☁︎ {choice.label}
              {metrics && metrics.turns > 0 ? ` · $${metrics.costUsd.toFixed(3)}` : ""}
            </span>
          )}
          <button className="btn-ghost" onClick={onChangeModel}>
            {choice.label}
          </button>
        </div>
      </header>

      {gpuLost && (
        <div className="gpu-lost">
          <div>
            <strong>Your GPU ran out of memory for this model.</strong> {choice.label} was too heavy and the
            graphics device was lost. Switch to a lighter on-device model (the ~1.6 GB Qwen 3B runs on almost any
            machine) and your analysis picks back up.
          </div>
          <button className="btn-primary" onClick={onChangeModel}>
            Pick a lighter model
          </button>
        </div>
      )}

      <div className="ws-body">
        <ChatPanel pi={pi} disabled={notReady || gpuLost} />
        <section className="artifact">
          <div className="artifact-tabs">
            <button
              className={"artifact-tab" + (tab === "dashboard" ? " artifact-tab-on" : "")}
              onClick={() => setTab("dashboard")}
            >
              📊 Dashboard
            </button>
            <button
              className={"artifact-tab" + (tab === "files" ? " artifact-tab-on" : "")}
              onClick={() => setTab("files")}
            >
              🗂️ Files
              {fileCount > 0 && <span className="artifact-tab-count">{fileCount}</span>}
            </button>
          </div>
          <div className="artifact-panel" hidden={tab !== "dashboard"}>
            <DashboardPreview chat={pi.chat} busy={pi.busy} />
          </div>
          <div className="artifact-panel" hidden={tab !== "files"}>
            <FileExplorer chat={pi.chat} />
          </div>
        </section>
      </div>

      <footer className="ws-foot muted small">
        {notReady
          ? `Starting sandbox… (${c2w.status}${c2w.log ? ` — ${c2w.log}` : ""})`
          : pi.busy
            ? "Working…"
            : usedFallback
              ? "Built a starter dashboard from your data — ask for any change."
              : "Ready — ask for any change to the dashboard."}
      </footer>
    </div>
  );
}
