/**
 * `wepi/wllama` — run ANY GGUF model *locally in the browser* via wllama
 * (llama.cpp compiled to WebAssembly, WebGPU-accelerated since wllama v3.1),
 * with no API key and no network calls to any provider.
 *
 *   import { createWllamaProvider } from "wepi/wllama";
 *   import wasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url"; // vite
 *   const { provider, modelId } = await createWllamaProvider({
 *     repo: "Qwen/Qwen3-4B-Instruct-2507-GGUF",
 *     quant: "Q4_K_M",
 *     wasmUrl,
 *     onProgress: ({ loaded, total }) => console.log(loaded / total),
 *   });
 *   const chat = await createChat({ provider, model: modelId }); // keyless
 *
 * Why this exists next to `wepi/webllm`: WebLLM only runs MLC-precompiled
 * models, so the newest open-source releases lag behind. llama.cpp gets new
 * architectures first and every GGUF on Hugging Face works with zero
 * conversion — day-one model availability. Chunk translation is shared with
 * webllm (`../local/openai-engine.ts`); wllama's `createChatCompletion` is
 * OpenAI-shaped, so the adapter here is just transport wiring.
 *
 * @wllama/wllama is an OPTIONAL peer dependency: it is only loaded here. Either
 * pass a pre-created *and pre-loaded* `engine` (a `Wllama` instance after
 * `loadModelFromHF`/`loadModelFromUrl` — recommended for full control), or pass
 * a model source (`repo`+`file`/`quant`, or `url`) plus `wasmUrl` and let this
 * module lazy-load wllama and build the engine for you.
 *
 * Practical notes:
 * - Tool calling works via llama.cpp chat templates — pick a model trained for
 *   function calling (Qwen3, Llama-3.x-Instruct, Hermes, ...).
 * - Files >2GB must be split GGUF (`llama-gguf-split`, ≤512MB shards); pass all
 *   shard URLs to `url` or just the first shard's HF `file`.
 * - Serve with COOP/COEP headers to unlock multi-threaded WASM.
 * - Avoid IQ-quants (slow on WASM); prefer Q4_K_M and friends.
 */

import { createProvider } from "@earendil-works/pi-ai";
import type { Api, Context, Model, Provider, ProviderAuth, StreamOptions } from "@earendil-works/pi-ai";
import { runLocalStream } from "../local/openai-engine.js";
import type { LocalChatEngine, OpenAIChatChunk } from "../local/openai-engine.js";

/** A progress report emitted while the GGUF downloads. */
export interface WllamaProgress {
  loaded: number;
  total: number;
}

/**
 * Minimal structural type of the bits of a `Wllama` instance we use. Kept
 * permissive (`createChatCompletion` takes/returns `any`) so a real
 * `@wllama/wllama` `Wllama` — whose method is overloaded on `stream` — is
 * assignable without importing its types.
 */
export interface WllamaEngine {
  createChatCompletion(options: any): Promise<any>;
}

export interface CreateWllamaProviderOptions {
  /** Hugging Face repo, e.g. "Qwen/Qwen3-4B-Instruct-2507-GGUF". Use with `file` or `quant`. */
  repo?: string;
  /** File path inside the HF repo, e.g. "qwen3-4b-instruct-2507-q4_k_m.gguf". */
  file?: string;
  /** GGUF quant name to auto-pick from the repo, e.g. "Q4_K_M" (wllama's default). */
  quant?: string;
  /** Direct GGUF URL, or the list of shard URLs for a split model. Alternative to `repo`. */
  url?: string | string[];
  /**
   * A pre-created, pre-loaded `Wllama` instance. When set, all loading options
   * above are ignored and `modelId` is only used as the reported model id.
   */
  engine?: WllamaEngine;
  /**
   * URL of wllama's single WASM build — required when this module creates the
   * engine. With vite: `import wasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url"`.
   */
  wasmUrl?: string;
  /** Progress while the GGUF downloads (only used when this module creates the engine). */
  onProgress?: (progress: WllamaProgress) => void;
  /** Layers to offload to WebGPU. Default: all (wllama offloads everything it can). Set 0 to force CPU. */
  nGpuLayers?: number;
  /** Model context window in tokens; also used as llama.cpp `n_ctx` on load. Default 8192. */
  contextWindow?: number;
  /** Max output tokens per turn. Default 4096. */
  maxTokens?: number;
  /** Reported model id. Default: derived from `repo`/`file`/`url`, or "local-gguf". */
  modelId?: string;
  /** Override the module specifier to import (advanced/testing). Default "@wllama/wllama". */
  moduleSpecifier?: string;
}

const PROVIDER_ID = "wllama";

/** Keyless auth: always resolves (a local engine is always "configured"). */
const KEYLESS_AUTH: ProviderAuth = {
  apiKey: {
    name: "wllama (local, no key)",
    async resolve() {
      return { auth: {}, source: "local" };
    },
  },
};

/**
 * Build a keyless pi-ai `Provider` backed by a local wllama (llama.cpp/WASM)
 * engine. Pass the returned `{ provider, modelId }` to
 * `createChat({ provider, model })`.
 */
export async function createWllamaProvider(
  options: CreateWllamaProviderOptions,
): Promise<{ provider: Provider; modelId: string; engine: WllamaEngine }> {
  const modelId = options.modelId ?? defaultModelId(options);
  const engine = options.engine ?? (await loadEngine(options));

  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? 8192,
    maxTokens: options.maxTokens ?? 4096,
  };

  const chatEngine: LocalChatEngine = {
    // wllama takes the abort signal in-band; llama.cpp stops decoding on abort,
    // so no separate interrupt() is needed.
    createStream: (request, signal) =>
      engine.createChatCompletion({
        ...request,
        abortSignal: signal,
      }) as Promise<AsyncIterable<OpenAIChatChunk>>,
  };

  const stream = (requestModel: Model<Api>, context: Context, streamOptions?: StreamOptions) =>
    // llama.cpp chat templates accept a real `system` message alongside tools,
    // so no system-prompt folding here (unlike webllm).
    runLocalStream(chatEngine, requestModel, context, streamOptions);

  const provider = createProvider({
    id: PROVIDER_ID,
    name: "wllama (local)",
    auth: KEYLESS_AUTH,
    models: [model],
    api: { stream, streamSimple: stream },
  });

  return { provider, modelId, engine };
}

function defaultModelId(options: CreateWllamaProviderOptions): string {
  if (options.repo) {
    return options.file ? `${options.repo}/${options.file}` : options.repo;
  }
  const url = Array.isArray(options.url) ? options.url[0] : options.url;
  if (url) {
    const base = url.split("/").pop();
    if (base) return base;
  }
  return "local-gguf";
}

/** Lazy-load @wllama/wllama (variable specifier keeps it out of the core graph). */
async function loadEngine(options: CreateWllamaProviderOptions): Promise<WllamaEngine> {
  if (!options.repo && !options.url) {
    throw new Error(
      "createWllamaProvider: pass a model source (`repo` + `file`/`quant`, or `url`) or a pre-loaded `engine`.",
    );
  }
  if (!options.wasmUrl) {
    throw new Error(
      'createWllamaProvider: pass `wasmUrl` (vite: `import wasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url"`) or a pre-loaded `engine`.',
    );
  }
  const specifier = options.moduleSpecifier ?? "@wllama/wllama";
  // Variable specifier: bundler-opaque so @wllama/wllama stays optional and the
  // core SDK typechecks without it installed.
  const wllamaModule: any = await import(/* @vite-ignore */ specifier as string);
  const wllama = new wllamaModule.Wllama({ default: options.wasmUrl });

  const loadParams: Record<string, unknown> = {
    n_ctx: options.contextWindow ?? 8192,
    progressCallback: options.onProgress,
  };
  if (options.nGpuLayers !== undefined) loadParams.n_gpu_layers = options.nGpuLayers;

  if (options.repo) {
    await wllama.loadModelFromHF(
      { repo: options.repo, file: options.file, quant: options.quant },
      loadParams,
    );
  } else {
    await wllama.loadModelFromUrl(options.url, loadParams);
  }
  return wllama as WllamaEngine;
}
