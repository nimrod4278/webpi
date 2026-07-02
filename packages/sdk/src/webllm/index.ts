/**
 * `wepi/webllm` — run models *locally in the browser* via WebLLM + WebGPU, with
 * no API key and no network calls to any provider.
 *
 *   import { createWebLLMProvider } from "wepi/webllm";
 *   const { provider, modelId } = await createWebLLMProvider({
 *     model: "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
 *     onProgress: (p) => console.log(p.text),
 *   });
 *   const chat = await createChat({ provider, model: modelId }); // keyless
 *
 * This wraps a WebLLM engine as a first-class pi-ai `Provider` (via
 * `createProvider`), translating pi-ai's `Context` into OpenAI chat-completion
 * params and the engine's streamed OpenAI-shaped chunks back into pi-ai's
 * `AssistantMessageEvent` stream (shared with `wepi/wllama` — see
 * `../local/openai-engine.ts`). That's the same `Provider`-object seam
 * `createChat({ provider })` uses for any cloud provider — local is just a
 * keyless provider whose transport is a WebGPU engine instead of HTTP.
 *
 * @mlc-ai/web-llm is an OPTIONAL peer dependency: it is only loaded here. Either
 * pass a pre-created `engine` (recommended for bundlers — import web-llm in your
 * app and call `CreateMLCEngine` yourself), or pass `model` and let this module
 * lazy-load web-llm and build the engine for you.
 *
 * IMPORTANT — tool calling: the pi agent drives its file/bash tools through
 * function calls, so pick a WebLLM model with real function-calling support
 * (e.g. `Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC`, or a Llama-3.1-8B FC build).
 * Instruct-only models will chat but won't reliably call tools.
 *
 * NOTE — model availability: WebLLM only runs MLC-precompiled models, so the
 * newest open-source releases lag behind. For day-one GGUF support see
 * `wepi/wllama`.
 */

import { createProvider } from "@earendil-works/pi-ai";
import type { Api, Context, Model, Provider, ProviderAuth, StreamOptions } from "@earendil-works/pi-ai";
import { runLocalStream } from "../local/openai-engine.js";
import type { LocalChatEngine, OpenAIChatChunk } from "../local/openai-engine.js";

/** A progress report emitted while a local model's weights download/compile. */
export interface WebLLMProgress {
  progress: number;
  text: string;
  timeElapsed?: number;
}

/**
 * Minimal structural type of the bits of a WebLLM engine we use. Kept permissive
 * (`create` takes/returns `any`) so a real `@mlc-ai/web-llm` `MLCEngine` — whose
 * `create` is heavily overloaded — is assignable without importing its types.
 */
export interface WebLLMEngine {
  chat: {
    completions: {
      create(request: any): Promise<any>;
    };
  };
  interruptGenerate?(): void | Promise<void>;
}

export interface CreateWebLLMProviderOptions {
  /** WebLLM model id, e.g. "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC". Required unless `engine` is passed. */
  model?: string;
  /** A pre-created WebLLM engine. When set, `model` is only used as the reported model id. */
  engine?: WebLLMEngine;
  /** Progress while weights download/compile (only used when this module creates the engine). */
  onProgress?: (progress: WebLLMProgress) => void;
  /** Model context window in tokens (for the metrics/context bar). Default 8192. */
  contextWindow?: number;
  /** Max output tokens per turn. Default 4096. */
  maxTokens?: number;
  /** Override the module specifier to import (advanced/testing). Default "@mlc-ai/web-llm". */
  moduleSpecifier?: string;
}

const PROVIDER_ID = "webllm";

/** Keyless auth: always resolves (a local engine is always "configured"). */
const KEYLESS_AUTH: ProviderAuth = {
  apiKey: {
    name: "WebLLM (local, no key)",
    async resolve() {
      return { auth: {}, source: "local" };
    },
  },
};

/**
 * Build a keyless pi-ai `Provider` backed by a local WebLLM/WebGPU engine.
 * Pass the returned `{ provider, modelId }` to `createChat({ provider, model })`.
 */
export async function createWebLLMProvider(
  options: CreateWebLLMProviderOptions,
): Promise<{ provider: Provider; modelId: string; engine: WebLLMEngine }> {
  const modelId = options.model ?? "local";
  const engine = options.engine ?? (await loadEngine(options, modelId));

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
    createStream: (request) =>
      engine.chat.completions.create({
        ...request,
        stream_options: { include_usage: true },
      }) as Promise<AsyncIterable<OpenAIChatChunk>>,
    interrupt: () => engine.interruptGenerate?.(),
  };

  const stream = (requestModel: Model<Api>, context: Context, streamOptions?: StreamOptions) =>
    // WebLLM function-calling models reject a custom `system` message when
    // `tools` are set, hence foldSystemIntoUserWhenTools.
    runLocalStream(chatEngine, requestModel, context, streamOptions, {
      foldSystemIntoUserWhenTools: true,
    });

  const provider = createProvider({
    id: PROVIDER_ID,
    name: "WebLLM (local)",
    auth: KEYLESS_AUTH,
    models: [model],
    api: { stream, streamSimple: stream },
  });

  return { provider, modelId, engine };
}

/** Lazy-load @mlc-ai/web-llm (variable specifier keeps it out of the core graph). */
async function loadEngine(
  options: CreateWebLLMProviderOptions,
  modelId: string,
): Promise<WebLLMEngine> {
  if (!options.model) {
    throw new Error("createWebLLMProvider: pass `model` (a WebLLM model id) or a pre-created `engine`.");
  }
  const specifier = options.moduleSpecifier ?? "@mlc-ai/web-llm";
  // Variable specifier: bundler-opaque so @mlc-ai/web-llm stays optional and the
  // core SDK typechecks without it installed.
  const webllm: any = await import(/* @vite-ignore */ specifier as string);
  return (await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: options.onProgress,
  })) as WebLLMEngine;
}
