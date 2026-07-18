/**
 * ModelSetup — how the user picks the engine that will analyse their data.
 *
 * Reframed as a PRIVACY choice: the default and headline path runs an
 * open-source model fully on-device over WebGPU — nothing leaves the browser;
 * a secondary "use my own API key" path routes to a cloud provider for the
 * hardest datasets. Two on-device engines, one dropdown:
 *
 *  - wllama (llama.cpp/WASM, WebGPU-offloaded): any GGUF, universal fallback.
 *  - WebLLM (MLC, fully GPU-resident): weights + KV cache live in Chrome's GPU
 *    process, OUTSIDE the tab's 4 GB WASM cap — the only zero-install way to
 *    run 8B-class models. Gated by `gpuCaps` so we never offer a ~5 GB model
 *    to a machine that would OOM its GPU process. WebLLM enforces a
 *    function-calling allowlist; only Hermes-2-Pro/Hermes-3 ids accept `tools`,
 *    which the wepi agent needs for bash/write.
 *
 * The local-engine loader keeps the lazy-load pattern the SDK example
 * established — the app owns the engine so the bundler resolves the optional
 * peer dep, then hands it to wepi keyless. Engines are heavy residents
 * (1.6–5 GB of WASM/GPU memory), so exactly one lives at a time: `resident`
 * below is disposed before a new load, and `ModelChoice.dispose` lets the app
 * free it on "change model".
 */

import { useEffect, useState } from "react";
import type { Provider } from "@wepi/sdk";
import { detectGpuCaps, fitsGpu, type GpuCaps } from "../gpuCaps";

/** What the rest of the app consumes — local (Provider object) or cloud (id + key). */
export interface ModelChoice {
  provider?: string | Provider;
  model?: string;
  apiKey?: string;
  /** True when inference runs fully on-device (drives the privacy indicator). */
  local: boolean;
  /** Human label for the header, e.g. "Qwen2.5 Coder 3B (local)" or "Claude". */
  label: string;
  /** Free the engine's WASM/GPU memory. Call when discarding this choice. */
  dispose?: () => Promise<void>;
}

const CLOUD = [
  { id: "anthropic", label: "Claude", model: "claude-sonnet-4-5", keyHint: "sk-ant-…" },
  { id: "openai", label: "GPT", model: "gpt-5.1", keyHint: "sk-…" },
  { id: "google", label: "Gemini", model: "gemini-2.5-pro", keyHint: "AIza…" },
] as const;

/**
 * On-device models. `ctx`/`maxTokens` feed the SDK's context budgeting (local
 * windows are HARD limits — llama.cpp aborts past n_ctx), so they must match
 * what the engine is loaded with.
 *
 * wllama constraint: a model FILE must stay under ~2 GB unless it's a split
 * GGUF — over it, the tail tensors truncate and llama.cpp reports "data is not
 * within the file bounds". Qwen3-4B only fits at the lossy Q2_K; the
 * code-tuned 3B at Q3_K_M is the reliable universal default.
 *
 * WebLLM: `Hermes-3-Llama-3.1-8B-q4f16_1-MLC` is the strongest prebuilt on
 * webllm's function-calling allowlist (~4.9 GB GPU memory, verified in
 * @mlc-ai/web-llm 0.2.84); shown only when gpuCaps says it plausibly fits.
 */
type LocalModel =
  | {
      engine: "wllama";
      id: string;
      repo: string;
      file: string;
      label: string;
      ctx: number;
      maxTokens: number;
    }
  | {
      engine: "webllm";
      id: string;
      label: string;
      ctx: number;
      maxTokens: number;
      /** MLC `vram_required_MB` — approximate GPU working set. */
      vramMB: number;
      /** q4f16 builds need the GPU's `shader-f16` feature or they can't run. */
      requiresShaderF16: boolean;
    };

// Order matters: the FIRST entry is the default. It is deliberately the small,
// universally-runnable wllama GGUF — the WebLLM 8B tier is powerful but its
// GPU-resident weights can exceed what a given machine's GPU can actually
// allocate (WebGPU can't report VRAM), so it must be an explicit opt-in, never
// the default. A too-heavy pick fails via the device-loss recovery in
// Workspace.tsx rather than a silent crash.
const LOCAL_MODELS: LocalModel[] = [
  {
    engine: "wllama",
    id: "qwen2.5-coder-3b-instruct",
    repo: "bartowski/Qwen2.5-Coder-3B-Instruct-GGUF",
    file: "Qwen2.5-Coder-3B-Instruct-Q3_K_M.gguf",
    label: "Qwen2.5 Coder 3B (~1.6 GB, recommended — runs anywhere)",
    ctx: 8192,
    maxTokens: 3072,
  },
  {
    engine: "wllama",
    id: "qwen2.5-coder-1.5b-instruct",
    repo: "bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    file: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
    label: "Qwen2.5 Coder 1.5B (~1 GB, fastest — lighter dashboards)",
    ctx: 8192,
    maxTokens: 3072,
  },
  {
    engine: "webllm",
    id: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
    label: "Hermes 3 Llama 3.1 8B (~4.9 GB GPU — strongest, powerful GPU only)",
    ctx: 8192,
    maxTokens: 3072,
    vramMB: 4877,
    requiresShaderF16: true,
  },
  {
    engine: "wllama",
    id: "qwen3-4b-instruct-2507",
    repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
    file: "Qwen3-4B-Instruct-2507-Q2_K.gguf",
    label: "Qwen3 4B Instruct (~1.7 GB, Q2 — larger but lossy)",
    ctx: 8192,
    maxTokens: 3072,
  },
];

/**
 * The one engine currently holding WASM/GPU memory. Loading a second model on
 * top of a live one is how the tab used to OOM — always dispose the resident
 * first, whether the swap comes from here or from the app's "change model".
 */
let resident: { dispose: () => Promise<void> } | null = null;

export function ModelSetup({ onReady }: { onReady: (c: ModelChoice) => void }) {
  const [mode, setMode] = useState<"local" | "cloud">("local");

  // Local state
  const [caps, setCaps] = useState<GpuCaps | undefined>();
  const [localId, setLocalId] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; text: string } | undefined>();
  const [error, setError] = useState<string | undefined>();

  // Cloud state
  const [cloudId, setCloudId] = useState<(typeof CLOUD)[number]["id"]>("anthropic");
  const [key, setKey] = useState("");
  const cloud = CLOUD.find((c) => c.id === cloudId)!;

  // Probe the GPU once, then offer only models this machine can plausibly run
  // and default to the strongest of them.
  useEffect(() => {
    void detectGpuCaps().then(setCaps);
  }, []);
  // wllama runs anywhere; a WebLLM model only appears once the GPU probe says it
  // can plausibly hold it (shader-f16 + buffer limits). `available[0]` is the
  // recommended 3B, so the default is always the safe pick.
  const available = LOCAL_MODELS.filter(
    (m) => m.engine === "wllama" || (caps !== undefined && fitsGpu(caps, m)),
  );
  const selected = available.find((m) => m.id === localId) ?? available[0];

  const startCloud = (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    onReady({ provider: cloudId, model: cloud.model, apiKey: key.trim(), local: false, label: cloud.label });
  };

  const startLocal = async () => {
    if (!selected) return;
    setLoading(true);
    setError(undefined);
    try {
      await resident?.dispose().catch(() => {});
      resident = null;
      const name = selected.label.split(" (")[0];
      const { provider, modelId, dispose } =
        selected.engine === "webllm"
          ? await loadWebLLM(selected, name, setProgress)
          : await loadWllama(selected, name, setProgress);
      const handle = {
        dispose: async () => {
          if (resident === handle) resident = null;
          await dispose();
        },
      };
      resident = handle;
      onReady({ provider, model: modelId, local: true, label: `${name} (local)`, dispose: handle.dispose });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  // Recovery for wllama's "Model file not found" (and similar) failures, which
  // mean the GGUF never fully cached — a stale partial blob then fails the same
  // way on every retry. Clear the OPFS cache, then re-run the normal load.
  const clearCacheAndRetry = async () => {
    setLoading(true);
    setError(undefined);
    setProgress({ pct: 0, text: "Clearing cached model files…" });
    try {
      await clearWllamaCache();
    } catch {
      // Best-effort: a failed clear shouldn't block the retry that follows.
    }
    await startLocal();
  };

  return (
    <div className="setup">
      <h2 className="setup-title">Choose how to analyse your data</h2>

      <div className="tabs">
        <button className={"tab" + (mode === "local" ? " tab-on" : "")} onClick={() => setMode("local")} disabled={loading}>
          🔒 On-device &amp; private
        </button>
        <button className={"tab" + (mode === "cloud" ? " tab-on" : "")} onClick={() => setMode("cloud")} disabled={loading}>
          Use my own API key
        </button>
      </div>

      {mode === "local" ? (
        <div className="setup-body">
          <p className="muted">
            An open-source model runs entirely in your browser over WebGPU. Your file, your questions, and the results{" "}
            <strong>never leave this machine</strong> — no account, no API key, works offline after the first load.
          </p>
          <label className="field-label">Model (downloaded once, then cached)</label>
          <select value={selected?.id ?? ""} onChange={(e) => setLocalId(e.target.value)} disabled={loading}>
            {available.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {selected?.engine === "webllm" && !loading && (
            <p className="muted small">
              ⚡ Strongest quality, but it loads ~5 GB into your GPU — if your graphics memory is limited it may fail
              to load or crash mid-analysis. You can switch back to a lighter model at any time.
            </p>
          )}
          <button className="btn-primary" onClick={startLocal} disabled={loading || !selected}>
            {loading ? "Loading model…" : "Start privately"}
          </button>
          {progress && (
            <div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${progress.pct}%` }} />
              </div>
              <p className="muted small">{progress.text}</p>
            </div>
          )}
          {error && (
            <div>
              <p className="error">{error}</p>
              {selected?.engine === "wllama" && (
                <>
                  <p className="muted small">
                    The model download didn't finish caching — usually low free disk space or an interrupted
                    download. Clearing the cached files and downloading again fixes it.
                  </p>
                  <button className="btn-ghost" onClick={clearCacheAndRetry} disabled={loading}>
                    Clear cache &amp; retry
                  </button>
                </>
              )}
            </div>
          )}
          {caps && !caps.webgpu ? (
            <p className="error">
              WebGPU isn't available in this browser, so the model would run on CPU only — slow, and large analyses
              may be unstable. Chrome or Edge recommended.
            </p>
          ) : (
            <p className="muted small">Requires a WebGPU-capable browser (Chrome or Edge).</p>
          )}
        </div>
      ) : (
        <form className="setup-body" onSubmit={startCloud}>
          <p className="muted">
            Route analysis through a cloud model for the hardest datasets. Your API key stays in this browser, but the{" "}
            data sent for analysis leaves your machine — pick on-device above if that matters.
          </p>
          <label className="field-label">Provider</label>
          <select value={cloudId} onChange={(e) => setCloudId(e.target.value as typeof cloudId)}>
            {CLOUD.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} — {c.model}
              </option>
            ))}
          </select>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={`${cloud.label} API key (${cloud.keyHint})`}
          />
          <button className="btn-primary" type="submit">
            Start with {cloud.label}
          </button>
        </form>
      )}
    </div>
  );
}

type Loaded = { provider: Provider; modelId: string; dispose: () => Promise<void> };
type SetProgress = (p: { pct: number; text: string }) => void;

/**
 * wllama: lazy-load the engine + its WASM + wepi's provider so cloud users
 * never pull it into their bundle. The app builds the engine (the bundler
 * resolves the package + WASM) and hands it to wepi keyless — wepi's own
 * loader uses a bundler-opaque variable import that won't resolve in-browser.
 */
/**
 * Wipe wllama's cached GGUF files from OPFS. Used by the "clear cache & retry"
 * recovery: a partial/interrupted download (or an OPFS quota shortfall) leaves
 * the cache in a state where wllama's own loader throws "Model file not found"
 * on every subsequent attempt until the stale blobs are removed. Constructed
 * exactly like `loadWllama` below so `setCompat` sees the same wasm base.
 */
async function clearWllamaCache(): Promise<void> {
  const [{ Wllama }, { default: wasmUrl }] = await Promise.all([
    import("@wllama/wllama"),
    import("@wllama/wllama/esm/wasm/wllama.wasm?url"),
  ]);
  await new Wllama({ default: wasmUrl }).cacheManager.clear();
}

async function loadWllama(
  sel: Extract<LocalModel, { engine: "wllama" }>,
  name: string,
  setProgress: SetProgress,
): Promise<Loaded> {
  const [{ Wllama }, { default: wasmUrl }, { createWllamaProvider }] = await Promise.all([
    import("@wllama/wllama"),
    import("@wllama/wllama/esm/wasm/wllama.wasm?url"),
    import("@wepi/sdk/wllama"),
  ]);
  // wllama ships one unified WASM; `default` is the base it resolves it from.
  const wllama = new Wllama({ default: wasmUrl });
  await wllama.loadModelFromHF(
    { repo: sel.repo, file: sel.file },
    {
      n_ctx: sel.ctx,
      // K-cache at q8_0 halves the K half of KV memory with no flash-attention
      // requirement (V-quant would need flash_attn, which the WASM/WebGPU
      // backends don't reliably support).
      cache_type_k: "q8_0",
      // n_batch is the max tokens llama.cpp will accept in ONE prefill batch;
      // a prompt above it throws "Invalid input batch". Match it to n_ctx so any
      // prompt the SDK's context budgeting lets through (up to n_ctx - maxTokens)
      // prefills in one shot — the 512 default (and even 2048) fails once the
      // system prompt + tool schemas + history cross that line. n_ubatch still
      // chunks the physical compute at 512, so this costs almost no memory.
      n_batch: sel.ctx,
      progressCallback: ({ loaded, total }: { loaded: number; total: number }) =>
        setProgress({
          pct: total ? Math.round((loaded / total) * 100) : 0,
          text: `Downloading ${name}… ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB (one time, then cached)`,
        }),
    },
  );
  // One-time perf snapshot: catches silent single-thread (COOP/COEP broken)
  // or CPU-only (WebGPU init failed) regressions that would feel like "slow".
  console.info(
    "[insight] wllama context:",
    wllama.getLoadedContextInfo(),
    "crossOriginIsolated:",
    crossOriginIsolated,
  );
  setProgress({ pct: 100, text: "Starting the on-device engine…" });
  const { provider, modelId, dispose } = await createWllamaProvider({
    engine: wllama,
    modelId: sel.id,
    contextWindow: sel.ctx,
    maxTokens: sel.maxTokens,
  });
  return { provider, modelId, dispose };
}

/**
 * WebLLM: weights compile/upload straight into GPU memory. `context_window_size`
 * must be passed at engine creation (the prebuilt default is 4096) and mirrored
 * into the provider so wepi's context budgeting matches the real KV allocation.
 */
async function loadWebLLM(
  sel: Extract<LocalModel, { engine: "webllm" }>,
  name: string,
  setProgress: SetProgress,
): Promise<Loaded> {
  const [{ CreateMLCEngine }, { createWebLLMProvider }] = await Promise.all([
    import("@mlc-ai/web-llm"),
    import("@wepi/sdk/webllm"),
  ]);
  const engine = await CreateMLCEngine(
    sel.id,
    {
      initProgressCallback: (p) =>
        setProgress({
          pct: Math.round((p.progress ?? 0) * 100),
          text: p.text || `Downloading ${name}… (one time, then cached)`,
        }),
    },
    { context_window_size: sel.ctx },
  );
  const { provider, modelId, dispose } = await createWebLLMProvider({
    engine,
    model: sel.id,
    contextWindow: sel.ctx,
    maxTokens: sel.maxTokens,
  });
  return { provider, modelId, dispose };
}
