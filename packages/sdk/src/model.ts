/**
 * Model wiring: build a pi-ai model + the `streamFn`/`getApiKey` the agent needs.
 *
 * Default backend is Anthropic (Claude) called directly from the browser with the
 * user's API key. pi-ai officially supports browser usage and per-provider
 * tree-shaking, so registering only the provider we use keeps the bundle small.
 *
 * Production path: pass `baseUrl` to route requests through your own backend
 * proxy (which injects the real key server-side and sidesteps CORS) — then
 * `apiKey` is optional. Or pass `getApiKey` for short-lived tokens minted per
 * request. Shipping a long-lived provider key to end users is a POC-only setup.
 */

import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { WepiError } from "./errors.js";

export interface ModelConfig {
  /** Provider API key (browser-direct). Optional when `baseUrl` or `getApiKey` is set. */
  apiKey?: string;
  /** Resolve the API key per request — e.g. a short-lived token from your backend. */
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  /**
   * Override the provider endpoint, e.g. a backend proxy that injects the real
   * key and forwards to the provider. When set, `apiKey` may be omitted.
   */
  baseUrl?: string;
  /** pi-ai provider id. Default: "anthropic". */
  provider?: string;
  /** Model id from the provider catalog. Default: a current Claude. */
  model?: string;
}

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-5";

export interface BuiltModel {
  model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
  streamFn: StreamFn;
  getApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
}

export function buildModel(cfg: ModelConfig): BuiltModel {
  const provider = cfg.provider ?? DEFAULT_PROVIDER;
  const modelId = cfg.model ?? DEFAULT_MODEL;

  if (!cfg.apiKey && !cfg.getApiKey && !cfg.baseUrl) {
    throw new WepiError(
      "wepi: no credentials — pass apiKey, getApiKey, or baseUrl (a proxy that injects the key)",
      "auth",
    );
  }

  const models = createModels();
  models.setProvider(anthropicProvider());

  const found = models.getModel(provider, modelId);
  if (!found) {
    const available = models
      .getModels(provider)
      .map((m) => m.id)
      .slice(0, 20)
      .join(", ");
    throw new WepiError(
      `wepi: unknown model "${provider}/${modelId}". Available (${provider}): ${available}`,
      "unknown",
    );
  }
  const model = cfg.baseUrl ? { ...found, baseUrl: cfg.baseUrl } : found;

  return {
    model,
    streamFn: (m, ctx, opts) => models.stream(m, ctx, opts),
    getApiKey: cfg.getApiKey ?? (() => cfg.apiKey),
  };
}
