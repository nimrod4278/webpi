/**
 * Model wiring: build a pi-ai model + the `streamFn`/`getApiKey` the agent needs.
 *
 * Default backend is Anthropic (Claude) called directly from the browser with the
 * user's API key. pi-ai officially supports browser usage and per-provider
 * tree-shaking, so registering only the provider we use keeps the bundle small.
 *
 * Pluggable by design: swapping `anthropicProvider()` for `openaiProvider()` (with
 * a custom baseURL) points the same agent at Ollama / any OpenAI-compatible local
 * model. Left as a follow-up; Claude is the default.
 */

import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export interface ModelConfig {
  /** Provider API key (browser-direct). */
  apiKey: string;
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
  getApiKey: (provider: string) => string;
}

export function buildModel(cfg: ModelConfig): BuiltModel {
  const provider = cfg.provider ?? DEFAULT_PROVIDER;
  const modelId = cfg.model ?? DEFAULT_MODEL;

  const models = createModels();
  models.setProvider(anthropicProvider());

  const model = models.getModel(provider, modelId);
  if (!model) {
    const available = models
      .getModels(provider)
      .map((m) => m.id)
      .slice(0, 20)
      .join(", ");
    throw new Error(
      `wepi: unknown model "${provider}/${modelId}". Available (${provider}): ${available}`,
    );
  }

  return {
    model,
    streamFn: (m, ctx, opts) => models.stream(m, ctx, opts),
    getApiKey: () => cfg.apiKey,
  };
}
