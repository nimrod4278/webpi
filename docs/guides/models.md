# Models & providers

wepi is model-agnostic. You select a model two ways that compose: a **provider**
(who serves the model) and a **model** (which model). Both accept either a short
string id or a full object, and the default is Claude.

## Cloud providers by string id

Eight cloud providers are in the curated registry. Pass `provider` as a string
id and, optionally, a `model` id from that provider's catalog:

```ts
await createChat({ provider: "openai", model: "gpt-5.1",       apiKey });
await createChat({ provider: "google", model: "gemini-2.5-pro", apiKey });
await createChat({ provider: "groq",   model: "llama-3.3-70b-versatile", apiKey });
```

| Provider id | Default model |
| --- | --- |
| `anthropic` *(default)* | `claude-sonnet-4-5` |
| `openai` | `gpt-5.1` |
| `google` | `gemini-2.5-pro` |
| `mistral` | `mistral-large-latest` |
| `groq` | `llama-3.3-70b-versatile` |
| `xai` | `grok-4.3` |
| `deepseek` | `deepseek-v4-pro` |
| `openrouter` | `auto` |

Omit `provider` to get `anthropic`; omit `model` to get that provider's default
from the table. pi-ai lazy-loads each provider's SDK, so registering the whole
set stays cheap and `buildModel` stays synchronous.

If you pass an unknown provider id or a model id that isn't in the catalog,
`buildModel` throws a `WepiError` (code `unknown`) that lists the valid options.

## Any other provider: inject a `Provider` object

For a provider outside the curated set — or to keep the default bundle lean —
import the pi-ai provider factory and pass the object as `provider`:

```ts
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

await createChat({
  provider: deepseekProvider(),
  model: "deepseek-v4-pro",
  apiKey,
});
```

The same seam accepts a **local, keyless** provider (a WebGPU engine). Injected
providers skip the credential guard, so no `apiKey`/`baseUrl`/`getApiKey` is
required for them. See [Local models](local-models.md).

## Passing a full `Model` object

If you already have a pi-ai `Model` object (custom pricing, context window, or
endpoint), pass it as `model` to bypass the catalog lookup entirely:

```ts
import type { Model, Api } from "wepi";

const model: Model<Api> = { /* ... */ };
await createChat({ provider: "openai", model, apiKey });
```

## OpenAI-compatible endpoints

Anything that speaks the OpenAI API — a self-hosted gateway, Ollama, LM Studio,
a llama.cpp server — works by selecting `provider: "openai"` and pointing
`baseUrl` at it:

```ts
await createChat({
  provider: "openai",
  model: "qwen3:8b",
  baseUrl: "http://localhost:11434/v1", // Ollama
});
```

This is a native runtime talking over HTTP — distinct from the in-browser
WebGPU engines in [Local models](local-models.md).

## Choosing a model: function calling is required

The pi agent drives its file and bash tools through **function calls**. Pick a
model with real function-calling support. Every curated cloud model qualifies;
for local models the constraint is sharper (see that guide). Instruct-only
models will chat but won't reliably call tools, so the agent won't be able to
touch files or run commands.

## Overriding the system prompt

```ts
await createChat({
  apiKey,
  systemPrompt: "You are a terse senior engineer. Prefer minimal diffs.",
});
```

The default prompt tells pi it is a browser-based coding assistant with file and
bash tools over a workspace mounted at the working directory.

## Metrics

Regardless of provider, `chat.metrics` reports token and cost accounting drawn
from the provider catalog:

```ts
chat.metrics; // { turns, tokensIn, tokensOut, costUsd, contextPct }
```

`contextPct` is the fraction (0–1) of the model's context window used by the
**last** turn — handy for a "context full" indicator. For local models, cost is
zero and the context window comes from the provider you built.

## See also

- [Local models](local-models.md) — keyless WebGPU inference.
- [Networking & keys](networking-and-keys.md) — how credentials flow.
- [API reference](../api-reference.md) — `buildModel`, `ModelConfig`, `BuiltModel`.
