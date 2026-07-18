/**
 * Model wiring: build a pi-ai model + the `streamFn`/`getApiKey` the agent needs.
 *
 * wepi is model-agnostic. Cloud providers are selected by string id from a
 * curated registry (Claude, GPT, Gemini, Mistral, Groq, xAI, DeepSeek,
 * OpenRouter) — pi-ai lazy-loads each provider's SDK, so registering them is
 * cheap and this stays synchronous. Anything outside the registry — any other
 * pi-ai provider, an OpenAI-compatible endpoint, or a *local* engine (see
 * `@wepi/sdk/webllm`, which runs models in-browser via WebGPU) — plugs in through the
 * same seam: pass a pre-built pi-ai `Provider` object as `provider`.
 *
 * Default cloud backend is Anthropic (Claude) called directly from the browser
 * with the user's API key. Production path: pass `baseUrl` to route through your
 * own backend proxy (which injects the real key and sidesteps CORS) — then
 * `apiKey` is optional. Or pass `getApiKey` for short-lived tokens minted per
 * request. Shipping a long-lived provider key to end users is a POC-only setup.
 * Injected `Provider` objects are typically keyless (local models) — no
 * credentials are required for them.
 */

import { createModels } from "@earendil-works/pi-ai";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { WepiError } from "./errors.js";

export interface ModelConfig {
  /** Provider API key (browser-direct). Optional when `baseUrl`/`getApiKey` is set, or when a keyless `Provider` object is injected. */
  apiKey?: string;
  /** Resolve the API key per request — e.g. a short-lived token from your backend. */
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  /**
   * Override the provider endpoint, e.g. a backend proxy that injects the real
   * key and forwards to the provider. When set, `apiKey` may be omitted.
   */
  baseUrl?: string;
  /**
   * Cloud provider id from the curated registry (default: "anthropic"), OR a
   * pre-built pi-ai `Provider` object for anything else — another pi-ai
   * provider, an OpenAI-compatible endpoint, or a local engine (`@wepi/sdk/webllm`).
   */
  provider?: string | Provider;
  /**
   * Model id from the provider catalog (default: a sensible per-provider
   * choice), OR a full pi-ai `Model` object (bypasses the catalog lookup).
   */
  model?: string | Model<Api>;
}

const DEFAULT_PROVIDER = "anthropic";

/** Curated cloud provider factories, selectable by string id. */
const FACTORIES: Record<string, () => Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  google: googleProvider,
  mistral: mistralProvider,
  groq: groqProvider,
  xai: xaiProvider,
  deepseek: deepseekProvider,
  openrouter: openrouterProvider,
};

/** Sensible default model per curated provider. */
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.1",
  google: "gemini-2.5-pro",
  mistral: "mistral-large-latest",
  groq: "llama-3.3-70b-versatile",
  xai: "grok-4.3",
  deepseek: "deepseek-v4-pro",
  openrouter: "auto",
};

export interface BuiltModel {
  model: Model<Api>;
  streamFn: StreamFn;
  getApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
}

export function buildModel(cfg: ModelConfig): BuiltModel {
  const models = createModels();

  // Resolve the provider: an injected Provider object (any provider, incl.
  // local/keyless) or a curated cloud id.
  let providerId: string;
  const injected = typeof cfg.provider === "object" && cfg.provider !== null;
  if (injected) {
    const provider = cfg.provider as Provider;
    providerId = provider.id;
    models.setProvider(provider);
  } else {
    providerId = (cfg.provider as string | undefined) ?? DEFAULT_PROVIDER;
    const factory = FACTORIES[providerId];
    if (!factory) {
      throw new WepiError(
        `wepi: unknown provider "${providerId}". Known: ${Object.keys(FACTORIES).join(", ")}. ` +
          "For any other provider, pass a pi-ai Provider object as `provider`.",
        "unknown",
      );
    }
    models.setProvider(factory());
  }

  // Cloud (string) providers need credentials; injected providers (local) don't.
  if (!injected && !cfg.apiKey && !cfg.getApiKey && !cfg.baseUrl) {
    throw new WepiError(
      "wepi: no credentials — pass apiKey, getApiKey, or baseUrl (a proxy that injects the key)",
      "auth",
    );
  }

  // A full Model object bypasses the catalog lookup.
  let model: Model<Api>;
  if (typeof cfg.model === "object" && cfg.model !== null) {
    model = cfg.model as Model<Api>;
  } else {
    const modelId = (cfg.model as string | undefined) ?? DEFAULT_MODELS[providerId] ?? "claude-sonnet-4-5";
    const found = models.getModel(providerId, modelId);
    if (!found) {
      const available = models
        .getModels(providerId)
        .map((m) => m.id)
        .slice(0, 20)
        .join(", ");
      throw new WepiError(
        `wepi: unknown model "${providerId}/${modelId}". Available (${providerId}): ${available}`,
        "unknown",
      );
    }
    model = found;
  }
  if (cfg.baseUrl) model = { ...model, baseUrl: cfg.baseUrl };

  return {
    model,
    streamFn: (m, ctx, opts) => models.stream(m, ctx, opts),
    getApiKey: cfg.getApiKey ?? (() => cfg.apiKey),
  };
}
