# Local models in the browser

wepi can run a model **entirely on-device over WebGPU** — no API key, no network
calls to any provider, no data leaving the page. Each local engine is exposed as
a keyless pi-ai `Provider`, so it plugs into `createChat({ provider })` exactly
like a cloud provider.

Three engines ship, each as an **optional peer dependency** loaded only by its
own subpath module:

| Subpath | Engine | Best for |
| --- | --- | --- |
| `@wepi/sdk/wllama` | llama.cpp → WASM (WebGPU since v3.1) | **Any GGUF on Hugging Face, day-one.** |
| `@wepi/sdk/webllm` | WebLLM / MLC | Mature runtime, MLC-precompiled models only. |
| `@wepi/sdk/litert` | Google LiteRT-LM | **Gemma 4**, with built-in function calling. |

## Requirements common to all three

- **WebGPU** in the browser.
- **Cross-origin isolation** (COOP/COEP headers) to unlock multi-threaded WASM —
  the same headers the bash sandbox needs. See [The bash sandbox](sandbox.md).
- **A function-calling model.** The agent drives tools through function calls, so
  an instruct-only model won't reliably touch files or run bash.

Each `create*Provider` returns `{ provider, modelId }`; hand both to
`createChat`:

```ts
const { provider, modelId } = await createWllamaProvider({ /* ... */ });
const chat = await createChat({ provider, model: modelId }); // keyless
```

## `@wepi/sdk/wllama` — any GGUF

llama.cpp gets new architectures first and every GGUF on Hugging Face works with
zero conversion, so the newest open-source models are available day-one.

```ts
import { createWllamaProvider } from "@wepi/sdk/wllama";
import wasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url"; // vite

const { provider, modelId } = await createWllamaProvider({
  repo: "Qwen/Qwen3-4B-Instruct-2507-GGUF",
  quant: "Q4_K_M",                                  // or an explicit `file`
  wasmUrl,
  onProgress: ({ loaded, total }) => console.log(loaded / total),
});

const chat = await createChat({ provider, model: modelId });
```

You can instead pass a **pre-created, pre-loaded** `Wllama` instance as `engine`
(recommended with bundlers — you own the load and `wasmUrl`); then the loading
options are ignored and `modelId` is only the reported id.

**Practical notes**

- Pick a function-calling model (Qwen3, Llama-3.x-Instruct, Hermes, …).
- Files over 2 GB must be **split GGUF** (≤512 MB shards); pass all shard URLs to
  `url`, or the first shard's HF `file`.
- Avoid IQ-quants (slow on WASM); prefer `Q4_K_M` and friends.
- Some repos ship only one quant. For example, Qwen's official
  `Qwen/Qwen3-*-GGUF` repos ship only `Q8_0`; auto-picking `Q4_K_M` fails with
  "No GGUF file found" — pin a quant/file that the repo actually contains.

## `@wepi/sdk/webllm` — MLC-precompiled models

A mature engine, but it only runs models MLC has precompiled, so the newest
releases lag. Choose a function-calling build.

```ts
import { createWebLLMProvider } from "@wepi/sdk/webllm";

const { provider, modelId } = await createWebLLMProvider({
  model: "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  onProgress: (p) => console.log(p.text), // download / compile progress
});

const chat = await createChat({ provider, model: modelId });
```

Or pass a pre-created `engine` (import `@mlc-ai/web-llm` and call
`CreateMLCEngine` yourself — recommended with bundlers).

**Function-calling caveat.** WebLLM's function-calling allowlist is small — the
five Hermes 7–8B builds (`Hermes-2-Pro-Mistral-7B`,
`Hermes-2-Pro-Llama-3-8B` q4f16/q4f32, `Hermes-3-Llama-3.1-8B` q4f16/q4f32). No
3B function-calling build exists; picking a non-FC model throws "not supported
for `ChatCompletionRequest.tools`". These are large (multi-GB) downloads and can
be heavy on the GPU.

## `@wepi/sdk/litert` — Gemma 4 with native tool calls

llama.cpp and MLC are text-first. LiteRT-LM is Google's on-device runtime (the
successor to MediaPipe LLM Inference) and the path Google ships Gemma 4 on. Its
`Conversation` has **built-in function calling**, so the agent gets structured
tool calls without a hand-rolled parser.

```ts
import { createLiteRTProvider } from "@wepi/sdk/litert";
import { Engine } from "@litert-lm/core"; // build the engine in your app (Vite)

const engine = await Engine.create({
  model: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm",
  mainExecutorSettings: { maxNumTokens: 8192 },
});

const { provider, modelId } = await createLiteRTProvider({ engine });
const chat = await createChat({ provider, model: modelId });
```

You can also pass `model` (a `.litertlm` URL or `ReadableStream`) and let the
module lazy-load `@litert-lm/core` and build the engine, but building it in your
app is recommended so the bundler resolves the package and its WASM.

**Scope notes (be honest with users):**

- **Vision is future-proofed, not guaranteed.** Image content is wired through to
  LiteRT image items and the conversation's `visionModalityEnabled`, but
  `@litert-lm/core` 0.12 is documented as text-in/text-out preview — the image
  path may be a no-op until a later runtime. **Tools + text work today.**
- **No audio.** pi-ai's content model carries text + image only, so Gemma 4's
  audio input is out of reach without extending pi-ai upstream.
- Bundles are WebGPU-carrying `.litertlm` files (E2B / E4B) and are license-gated
  on Hugging Face.

## Native local runtimes (no wepi code)

If you already run Ollama, LM Studio, or a llama.cpp server, that's just an
OpenAI-compatible HTTP endpoint — point `baseUrl` at it, no local subpath
needed:

```ts
await createChat({ provider: "openai", model: "qwen3:8b", baseUrl: "http://localhost:11434/v1" });
```

## Which should I use?

- **Latest open model, minimal fuss:** `@wepi/sdk/wllama` (any GGUF, day-one).
- **A blessed, stable Hermes build:** `@wepi/sdk/webllm`.
- **Gemma 4 specifically / Google's runtime:** `@wepi/sdk/litert`.
- **A model server you already run:** `baseUrl` + `provider: "openai"`.

## See also

- [Models & providers](models.md) — the provider seam these plug into.
- [The bash sandbox](sandbox.md) — cross-origin isolation these also require.
- [API reference](../api-reference.md) — the `create*Provider` option types.
