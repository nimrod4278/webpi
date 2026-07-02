/**
 * wepi-client — the canonical example of consuming the `wepi` SDK.
 *
 * Shows wepi's model-agnostic surface: pick a cloud provider (Claude / GPT /
 * Gemini) with a key, OR run a model fully locally in the browser over WebGPU —
 * via wllama (llama.cpp/WASM, any GGUF) or WebLLM (MLC precompiled) — with no
 * key and no provider calls. The chosen config is handed to both demos:
 *   1. <PiChat> — the batteries-included component from `wepi/react`.
 *   2. A hand-rolled UI on the `usePiChat` + `useC2wSandbox` hooks (CustomChat).
 */

import { useState } from "react";
import { PiChat } from "wepi/react";
import "wepi/react/PiChat.css";
import type { Provider } from "wepi";
import { CustomChat } from "./CustomChat";

const SEED_FILES = { "README.md": "# my project\n" };

/** What both demos consume — cloud (string provider + key) or local (Provider object). */
export interface ModelChoice {
  provider?: string | Provider;
  model?: string;
  apiKey?: string;
}

type Demo = "component" | "hooks";

/** Curated cloud providers surfaced in the picker (wepi supports more by string/object). */
const CLOUD = [
  { id: "anthropic", label: "Claude (Anthropic)", model: "claude-sonnet-4-5", keyHint: "sk-ant-…" },
  { id: "openai", label: "GPT (OpenAI)", model: "gpt-5.1", keyHint: "sk-…" },
  { id: "google", label: "Gemini (Google)", model: "gemini-2.5-pro", keyHint: "AIza…" },
] as const;

/**
 * WebLLM's function-calling allowlist (the pi agent drives its tools via
 * function calls, so ONLY these work — WebLLM rejects `tools` for other models).
 * All are 7–8B (~4–5 GB); there is no smaller FC model. Smallest first.
 */
const WEBLLM_MODELS = [
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
];

/**
 * Curated GGUFs for wllama (llama.cpp/WASM + WebGPU). Unlike WebLLM there is no
 * precompilation allowlist — ANY GGUF on Hugging Face works (swap in a repo the
 * day a model ships). These are small tool-calling-capable picks; single files
 * must stay under 2 GB (split GGUF above that). Quants are per-repo (Qwen's
 * official GGUF repos only ship Q8_0).
 */
const WLLAMA_MODELS = [
  { repo: "Qwen/Qwen3-1.7B-GGUF", quant: "Q8_0", label: "Qwen3 1.7B (~1.8 GB)" },
  { repo: "Qwen/Qwen3-0.6B-GGUF", quant: "Q8_0", label: "Qwen3 0.6B (~0.6 GB, quick test)" },
  { repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", quant: "Q4_K_M", label: "Llama 3.2 3B Instruct (~2 GB)" },
];

/**
 * Gemma 4 via LiteRT-LM (Google's on-device runtime — successor to MediaPipe
 * LLM Inference). This is the only in-browser path that unlocks Gemma 4's native
 * VISION input and its BUILT-IN function calling, so the agent drives tools with
 * structured calls (no text-parse shim). Web `.litertlm` bundles only — they
 * must contain WebGPU artifacts. E2B/E4B are the browser-sized picks; a dense
 * 12B bundle exists but is heavy and won't load on weak GPUs.
 *
 * NOTE: Gemma bundles are license-gated on Hugging Face — a first download may
 * need an HF token / accepted license, or self-host the .litertlm next to the app.
 */
const LITERT_MODELS = [
  {
    url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm",
    label: "Gemma 4 E2B (multimodal, ~3 GB) — fastest",
  },
  {
    url: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm",
    label: "Gemma 4 E4B (multimodal, ~4.4 GB) — stronger",
  },
];

type LocalEngine = "wllama" | "webllm" | "litert";

export function App() {
  const [choice, setChoice] = useState<ModelChoice | undefined>();
  const [demo, setDemo] = useState<Demo>("component");

  return (
    <main style={{ font: "14px/1.5 system-ui, sans-serif", maxWidth: 760, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>wepi</h1>
      <p style={{ color: "#888", fontSize: 12 }}>
        The pi coding agent, native in your browser. Files live in a sandboxed virtual workspace;{" "}
        <code>bash</code> runs in a container2wasm Alpine sandbox. Model-agnostic: any cloud provider,
        or a local model over WebGPU. Powered by the <code>wepi</code> SDK.
      </p>

      {!choice ? (
        <Setup onReady={setChoice} />
      ) : (
        <>
          <nav style={{ display: "flex", gap: "0.5rem", margin: "1rem 0", alignItems: "center" }}>
            <TabButton active={demo === "component"} onClick={() => setDemo("component")}>
              &lt;PiChat&gt; component
            </TabButton>
            <TabButton active={demo === "hooks"} onClick={() => setDemo("hooks")}>
              usePiChat hook
            </TabButton>
            <button onClick={() => setChoice(undefined)} style={{ font: "inherit", marginLeft: "auto", fontSize: 12, color: "#888", background: "none", border: "none", cursor: "pointer" }}>
              change model
            </button>
          </nav>

          {demo === "component" ? (
            <PiChat provider={choice.provider} model={choice.model} apiKey={choice.apiKey} files={SEED_FILES} />
          ) : (
            <CustomChat choice={choice} />
          )}
        </>
      )}
    </main>
  );
}

/** Provider/model chooser: cloud (key) or local (wllama GGUF / WebLLM download). */
function Setup({ onReady }: { onReady: (c: ModelChoice) => void }) {
  const [mode, setMode] = useState<"cloud" | "local">("cloud");

  // Cloud state
  const [cloudId, setCloudId] = useState<(typeof CLOUD)[number]["id"]>("anthropic");
  const [key, setKey] = useState("");
  const cloud = CLOUD.find((c) => c.id === cloudId)!;

  // Local state
  const [localEngine, setLocalEngine] = useState<LocalEngine>("wllama");
  const [webllmModel, setWebllmModel] = useState(WEBLLM_MODELS[0]);
  const [wllamaRepo, setWllamaRepo] = useState(WLLAMA_MODELS[0].repo);
  const [litertUrl, setLitertUrl] = useState(LITERT_MODELS[0].url);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; text: string } | undefined>();
  const [error, setError] = useState<string | undefined>();

  const startCloud = (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    onReady({ provider: cloudId, model: cloud.model, apiKey: key.trim() });
  };

  const startWebLLM = async () => {
    // Lazy-load both the engine and wepi's WebLLM provider so cloud users
    // never pull @mlc-ai/web-llm into their bundle.
    const [{ CreateMLCEngine }, { createWebLLMProvider }] = await Promise.all([
      import("@mlc-ai/web-llm"),
      import("wepi/webllm"),
    ]);
    const engine = await CreateMLCEngine(webllmModel, {
      initProgressCallback: (p: { progress: number; text: string }) =>
        setProgress({ pct: Math.round((p.progress ?? 0) * 100), text: p.text }),
    });
    const { provider, modelId } = await createWebLLMProvider({ engine, model: webllmModel, contextWindow: 8192 });
    onReady({ provider, model: modelId });
  };

  const startWllama = async () => {
    // Same lazy-load pattern as WebLLM: the app creates the engine (so the
    // bundler resolves @wllama/wllama and its wasm asset) and hands it to wepi.
    const [{ Wllama }, { createWllamaProvider }, wasmUrl] = await Promise.all([
      import("@wllama/wllama"),
      import("wepi/wllama"),
      import("@wllama/wllama/esm/wasm/wllama.wasm?url").then((m) => m.default),
    ]);
    const sel = WLLAMA_MODELS.find((m) => m.repo === wllamaRepo) ?? WLLAMA_MODELS[0];
    const engine = new Wllama({ default: wasmUrl });
    await engine.loadModelFromHF(
      { repo: sel.repo, quant: sel.quant },
      {
        n_ctx: 8192,
        progressCallback: ({ loaded, total }: { loaded: number; total: number }) =>
          setProgress({
            pct: total ? Math.round((loaded / total) * 100) : 0,
            text: `Downloading GGUF… ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`,
          }),
      },
    );
    const { provider, modelId } = await createWllamaProvider({ engine, modelId: wllamaRepo, contextWindow: 8192 });
    onReady({ provider, model: modelId });
  };

  const startLiteRT = async () => {
    // Same lazy-load pattern: the app builds the LiteRT-LM Engine (so the bundler
    // resolves @litert-lm/core + its WASM) and hands it to wepi. Gemma 4 runs
    // multimodally (vision) with built-in function calling, all on WebGPU.
    const [{ Engine }, { createLiteRTProvider }] = await Promise.all([
      import("@litert-lm/core"),
      import("wepi/litert"),
    ]);
    setProgress({ pct: 0, text: "Loading Gemma 4 (.litertlm)… first load can take a while" });
    const engine = await Engine.create({
      model: litertUrl,
      mainExecutorSettings: { maxNumTokens: 8192 },
    });
    setProgress({ pct: 100, text: "Compiling for WebGPU…" });
    const { provider, modelId } = await createLiteRTProvider({ engine, modelId: litertUrl, contextWindow: 8192 });
    onReady({ provider, model: modelId });
  };

  const startLocal = async () => {
    setLoading(true);
    setError(undefined);
    try {
      await (localEngine === "wllama" ? startWllama() : localEngine === "litert" ? startLiteRT() : startWebLLM());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 520 }}>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <TabButton active={mode === "cloud"} onClick={() => setMode("cloud")}>
          Cloud provider
        </TabButton>
        <TabButton active={mode === "local"} onClick={() => setMode("local")}>
          Local (in-browser)
        </TabButton>
      </div>

      {mode === "cloud" ? (
        <form onSubmit={startCloud} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <label style={{ fontSize: 12, color: "#888" }}>Provider</label>
          <select value={cloudId} onChange={(e) => setCloudId(e.target.value as typeof cloudId)} style={{ font: "inherit", padding: "0.5rem" }}>
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
            style={{ font: "inherit", padding: "0.5rem" }}
          />
          <button type="submit" style={{ font: "inherit", padding: "0.5rem 1rem", background: "#4f46e5", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}>
            Start
          </button>
        </form>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <label style={{ fontSize: 12, color: "#888" }}>Engine</label>
          <select value={localEngine} onChange={(e) => setLocalEngine(e.target.value as LocalEngine)} disabled={loading} style={{ font: "inherit", padding: "0.5rem" }}>
            <option value="litert">LiteRT-LM — Gemma 4, multimodal + tools (Google on-device)</option>
            <option value="wllama">wllama — llama.cpp/WASM, any GGUF (latest models)</option>
            <option value="webllm">WebLLM — MLC precompiled models</option>
          </select>
          <label style={{ fontSize: 12, color: "#888" }}>Local model (runs on WebGPU; first load downloads weights)</label>
          {localEngine === "litert" ? (
            <select value={litertUrl} onChange={(e) => setLitertUrl(e.target.value)} disabled={loading} style={{ font: "inherit", padding: "0.5rem" }}>
              {LITERT_MODELS.map((m) => (
                <option key={m.url} value={m.url}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : localEngine === "wllama" ? (
            <select value={wllamaRepo} onChange={(e) => setWllamaRepo(e.target.value)} disabled={loading} style={{ font: "inherit", padding: "0.5rem" }}>
              {WLLAMA_MODELS.map((m) => (
                <option key={m.repo} value={m.repo}>
                  {m.label} — {m.repo}
                </option>
              ))}
            </select>
          ) : (
            <select value={webllmModel} onChange={(e) => setWebllmModel(e.target.value)} disabled={loading} style={{ font: "inherit", padding: "0.5rem" }}>
              {WEBLLM_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
          <button onClick={startLocal} disabled={loading} style={{ font: "inherit", padding: "0.5rem 1rem", background: "#4f46e5", color: "#fff", border: "none", borderRadius: 6, cursor: loading ? "default" : "pointer" }}>
            {loading ? "Loading…" : "Load & start"}
          </button>
          {progress && (
            <div>
              <div style={{ height: 6, background: "#eee", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${progress.pct}%`, background: "#4f46e5", transition: "width .2s" }} />
              </div>
              <p style={{ fontSize: 11, color: "#888", margin: "0.25rem 0 0" }}>{progress.text}</p>
            </div>
          )}
          {error && <p style={{ fontSize: 12, color: "#c00", margin: 0 }}>{error}</p>}
          <p style={{ fontSize: 11, color: "#888", margin: 0 }}>
            Requires a WebGPU-capable browser (Chrome/Edge). No API key, no network calls to a provider.
            {localEngine === "litert" && (
              <>
                {" "}
                Gemma 4 runs via Google's LiteRT-LM with built-in function calling. The <code>.litertlm</code> bundle
                is license-gated on Hugging Face — the first download may need an accepted Gemma license, or self-host
                the file next to the app.
              </>
            )}
          </p>
        </div>
      )}
    </div>
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
