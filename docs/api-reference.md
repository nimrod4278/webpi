# API reference

Every public export, grouped by entry point. Types are described in prose where a
full signature would add noise; see the source for exact generics.

- [`wepi` (core)](#wepi-core)
- [`wepi/react`](#wepireact)
- [`wepi/c2w`](#wepic2w)
- [`wepi/wllama`](#wepiwllama)
- [`wepi/webllm`](#wepiwebllm)
- [`wepi/litert`](#wepilitert)

---

## `wepi` (core)

### `createChat(options): Promise<Chat>`

Create a chat. Restores the persisted snapshot first when `persist` is set, then
resolves. Construct `new Chat(...)` directly only if you don't need persistence.

### `ask(message, options): Promise<string>`

One-shot convenience: create a chat, send one message, dispose it, and return the
full reply. `options` is a `ChatOptions`.

### `class Chat`

| Member | Signature | Notes |
| --- | --- | --- |
| `fs` | `VirtualFS` | The observable virtual workspace. |
| `send` | `(message, opts?: SendOptions) => Turn` | Streams **and** awaits; throws `busy` if a turn is in flight. |
| `abort` | `() => void` | Abort the in-flight turn (it resolves). |
| `subscribe` | `(cb: (e: AgentEvent) => void) => () => void` | Raw agent events; returns unsubscribe. |
| `messages` | `readonly AgentMessage[]` | Conversation transcript (getter). |
| `metrics` | `ChatMetrics` | Token/cost accounting (getter). |
| `files` | `() => Record<string, string>` | Read the workspace back. |
| `restore` | `() => Promise<void>` | Load the persisted snapshot; called by `createChat`. |
| `dispose` | `() => void` | Abort + flush a final snapshot. |

### `interface ChatOptions`

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `apiKey` | `string` | — | Provider key (browser-direct). |
| `getApiKey` | `(provider: string) => string \| undefined \| Promise<…>` | — | Resolve the key per request. |
| `baseUrl` | `string` | — | Route provider requests through your proxy. |
| `model` | `string \| Model<Api>` | per-provider default | Model id or full `Model` object. |
| `provider` | `string \| Provider` | `"anthropic"` | Cloud id or a pi-ai `Provider` object. |
| `systemPrompt` | `string` | built-in | Override the system prompt. |
| `files` | `Record<string, string>` | `{}` | Seed the workspace by relative path. |
| `sandbox` | `Sandbox` | `NullSandbox` | Backend for the `bash` tool. |
| `workdir` | `string` | `/workspace` | Where the workspace is mirrored in the sandbox. |
| `tools` | `AgentTool[]` | `[]` | Extra agent tools to expose. |
| `persist` | `string \| { id; store: ChatStore }` | — | Persist + resume; string id uses IndexedDB. |
| `onPersistError` | `(error: unknown) => void` | `console.warn` | Background save failure handler. |

### `interface SendOptions`

- `onTool?: (event: ToolEvent) => void` — observe tool calls as they start and
  finish.

### `interface ChatMetrics`

- `turns: number` — assistant turns completed.
- `tokensIn: number` — input tokens (incl. cache reads/writes) across all turns.
- `tokensOut: number` — output tokens across all turns.
- `costUsd: number` — total cost in USD from the provider catalog.
- `contextPct: number` — fraction (0–1) of the model's context window used by the
  last turn.

### `class Turn`

Returned by `chat.send()`. Implements both `AsyncIterable<string>` (text deltas)
and `PromiseLike<string>` (the full reply). Use one per call.

| Member | Type | Notes |
| --- | --- | --- |
| `abort()` | `() => void` | Stop; the turn resolves with partial text. |
| `settled` | `boolean` | True once resolved or rejected. |
| `aborted` | `boolean` | True if stopped via `abort()`. |
| `newMessages` | `AgentMessage[]` | Messages produced during this turn (after completion). |

### `type ToolEvent`

```ts
type ToolEvent =
  | { type: "start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "end";   toolCallId: string; toolName: string; result: unknown; isError: boolean };
```

### Filesystem

- **`class VirtualFS`** — the observable in-memory workspace. `fs.onChange(cb)`
  subscribes to `FSChange`s; `fs.snapshot()` returns `{ path: contents }`;
  `fs.write(path, content)` writes.
- **`type FSChange`** — a change record emitted by `onChange`.
- **`createFileTools(fs)`** — build the read/write/edit/ls/grep agent tools over
  a `VirtualFS`.
- **`createBashTool(sandbox, opts)`** — build the `bash` tool bound to a sandbox;
  `opts` includes `{ fs?, workdir? }` for workspace sync. `BashToolOptions` types it.

### Sandbox

- **`interface Sandbox`** — `exec(command, opts?: { cwd?; signal? }): Promise<ExecResult>`.
- **`interface ExecResult`** — `{ stdout: string; stderr: string; code: number }`.
- **`class NullSandbox`** — default no-op sandbox (`bash` reports unavailable).

### Models

- **`buildModel(cfg: ModelConfig): BuiltModel`** — resolve provider + model, and
  return `{ model, streamFn, getApiKey }`.
- **`interface ModelConfig`** — `{ apiKey?, getApiKey?, baseUrl?, provider?, model? }`.
- **`interface BuiltModel`** — `{ model: Model<Api>; streamFn: StreamFn; getApiKey }`.
- Re-exported pi-ai types for custom/local providers: **`Api`**, **`Model`**,
  **`Provider`**.

See [Models & providers](guides/models.md) for the provider registry and defaults.

### Errors

- **`class WepiError`** — `{ message; code: WepiErrorCode; cause? }`.
- **`type WepiErrorCode`** — `"auth" | "rate_limit" | "aborted" | "busy" |
  "provider" | "sandbox" | "timeout" | "unknown"`.

See [Error handling](guides/error-handling.md).

### Persistence

- **`interface ChatStore`** — `load(id)`, `save(id, snapshot)`, optional
  `list()`, `delete(id)`.
- **`interface ChatSnapshot`** — `{ version: 1; messages; files; updatedAt }`.
- **`class IndexedDBStore`** — the default browser store.

See [Persistence](guides/persistence.md).

---

## `wepi/react`

Requires `react` and `react-dom` (>=18) as peer dependencies.

- **`<PiChat {...PiChatProps} />`** — drop-in component; boots the c2w sandbox.
  `PiChatProps` extends the `ChatOptions` surface.
- **`usePiChat(options: UsePiChatOptions): UsePiChatResult`** — headless chat
  hook. Options add `enabled?: boolean`. Result: `{ chat, ready, busy, error,
  transcript, send, abort, files }`.
- **`type TranscriptEntry`** — `{ id; role: "user" | "assistant"; text;
  streaming; tools: ToolEvent[] }`.
- **`useC2wSandbox(opts?): UseC2wSandboxResult`** — boots + warms the sandbox.
  Result: `{ sandbox, status, ready, log }`.
- **`type C2wStatus`** — `"idle" | "booting" | "warming" | "ready" | "error"`.

See [React bindings](guides/react.md).

---

## `wepi/c2w`

- **`class C2wSandbox`** — container2wasm Alpine VM implementing `Sandbox`.
  Constructor takes `C2wSandboxOptions` (`onLog`, `assetsBaseUrl`,
  `execTimeoutMs`, …). Methods include `exec(...)`, `reset()`, and a `ready`
  promise. Importing is side-effect-free.

See [The bash sandbox](guides/sandbox.md).

---

## `wepi/wllama`

Optional peer dependency: `@wllama/wllama` (>=3.1).

- **`createWllamaProvider(options): Promise<{ provider: Provider; modelId: string }>`**
  — build a keyless local provider from a GGUF.

`CreateWllamaProviderOptions` (key fields): `repo`, `file`, `quant`, `url` (string
or shard array), `wasmUrl`, `engine` (pre-loaded `Wllama`), `onProgress`,
`contextWindow`, and output limits.

See [Local models](guides/local-models.md#wepiwllama--any-gguf).

---

## `wepi/webllm`

Optional peer dependency: `@mlc-ai/web-llm` (>=0.2.79).

- **`createWebLLMProvider(options): Promise<{ provider; modelId }>`** — build a
  keyless local provider from an MLC-precompiled model.

`CreateWebLLMProviderOptions` (key fields): `model`, `engine` (pre-created MLC
engine), `onProgress`, `contextWindow` (default 8192), `maxTokens` (default 4096).

See [Local models](guides/local-models.md#wepiwebllm--mlc-precompiled-models).

---

## `wepi/litert`

Optional peer dependency: `@litert-lm/core` (>=0.12).

- **`createLiteRTProvider(options): Promise<{ provider; modelId }>`** — build a
  keyless local provider for Gemma 4 with built-in function calling.

Options (key fields): `engine` (pre-created `Engine` — recommended) **or** `model`
(a `.litertlm` URL or `ReadableStream`), plus context/output settings.

See [Local models](guides/local-models.md#wepilitert--gemma-4-with-native-tool-calls).
