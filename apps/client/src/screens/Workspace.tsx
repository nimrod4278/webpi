/**
 * Workspace — the product's main screen for one dataset.
 *
 * Boots the c2w bash sandbox (real Python for cloud models), creates the pi
 * agent wired to the chosen model + the analyst prompt, and gives it the
 * dashboard tools (agent/tools.ts) that mutate a DashboardStore. Layout is two
 * panes: the conversation (ChatPanel) and the live dashboard (Dashboard), which
 * re-renders as the agent adds/edits widgets. Everything persists per-dataset —
 * the dashboard state rides `dashboard.json` in the workspace snapshot — so a
 * reload resumes exactly. Once the agent is warm it kicks off the first analysis
 * automatically: the "drop a CSV, get a dashboard" moment.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { usePiChat, useC2wSandbox } from "@wepi/sdk/react";
import type { Chat, VirtualFS } from "@wepi/sdk";
import { ChatPanel } from "../chat/ChatPanel";
import { Dashboard } from "../dashboard/Dashboard";
import { DashboardStore } from "../dashboard/DashboardStore";
import { parseDashboard } from "../dashboard/types";
import { FileExplorer } from "../components/FileExplorer";
import { analystSystemPrompt, localAnalystSystemPrompt, DATA_PATH, DASHBOARD_JSON_PATH } from "../agent/prompts";
import { widgetTools } from "../agent/tools";
import { defaultDashboardFromProfile } from "../agent/defaults";
import { formatProfile, parseCsv, profileCsv } from "../data/profile";
import { isGpuLostError } from "../gpuCaps";
import type { Dataset } from "../lib";
import type { ModelChoice } from "./ModelSetup";

const KICKOFF = "Analyse data.csv and build me a dashboard of the most interesting findings.";

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
  const [tab, setTab] = useState<"dashboard" | "files">("dashboard");
  const [fileCount, setFileCount] = useState(0);

  // 1. Boot the sandbox that backs the bash tool (Python lives here).
  const c2w = useC2wSandbox();

  // Parse + profile the CSV once (deterministic, no model): the profile shapes
  // the local prompt and the fallback dashboard; the parsed rows feed both the
  // widget tools and the live widgets.
  const parsed = useMemo(() => parseCsv(dataset.text), [dataset]);
  const profile = useMemo(() => profileCsv(dataset.text), [dataset]);

  // The dashboard the agent edits — one store per dataset, survives model swaps.
  const store = useMemo(() => new DashboardStore(), [dataset.id]);
  // Small on-device models get a trimmed toolset (fewer tools = less prompt +
  // less choice paralysis); cloud models get all six.
  const tools = useMemo(
    () => (fs: VirtualFS) => widgetTools(store, fs, parsed, { minimal: choice.local }),
    [store, parsed, choice.local],
  );

  // 2. Create the agent once the sandbox exists, wired to the chosen model.
  //    Both tiers get the dashboard tools; small local models get ONLY those
  //    (defaultTools:false) to stay on rails, cloud models keep file+bash too.
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
    tools,
    ...(choice.local ? { defaultTools: false as const } : {}),
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

  // 3b. Hydrate the store when a Chat becomes ready. On a fresh reload the store
  //     is empty and we load the persisted dashboard.json; after a model swap the
  //     store already holds the truth, so we push it into the new chat's fs.
  const hydratedChat = useRef<Chat>();
  useEffect(() => {
    const chat = pi.chat;
    if (!pi.ready || !chat || hydratedChat.current === chat) return;
    hydratedChat.current = chat;
    if (store.getSnapshot().widgets.length > 0) {
      store.commit();
    } else {
      const saved = chat.files()[DASHBOARD_JSON_PATH];
      const state = saved ? parseDashboard(saved) : undefined;
      if (state) store.setAll(state);
    }
  }, [pi.ready, pi.chat, store]);

  // 4. Safety net (mainly for small models): if a turn ends and the dashboard is
  //    still empty, seed a starter dashboard from the deterministic profile so
  //    the user always gets something to edit.
  const [usedFallback, setUsedFallback] = useState(false);
  const fallbackRef = useRef(false);
  useEffect(() => {
    const chat = pi.chat;
    if (!chat) return;
    const unsub = chat.subscribe((event) => {
      if (event.type !== "agent_end" || fallbackRef.current) return;
      fallbackRef.current = true; // one check per session: succeed or fall back
      if (store.getSnapshot().widgets.length > 0) return;
      store.setAll(defaultDashboardFromProfile(profile));
      setUsedFallback(true);
    });
    return unsub;
  }, [pi.chat, profile, store]);

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
            <Dashboard store={store} parsed={parsed} csv={dataset.text} busy={pi.busy} />
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
