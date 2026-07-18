# wepi

Run the [**pi**](https://github.com/earendil-works/pi) coding agent **natively in the
browser** — no backend. The agent loop ([pi-agent-core](https://github.com/earendil-works/pi))
runs as ordinary JavaScript on the page; only the `bash` tool's commands execute inside a
[container2wasm](https://github.com/container2wasm/container2wasm) Alpine VM in a Web Worker.
The agent's workspace is mirrored into the VM around every shell command, so file tools and
`bash` see **one filesystem**: ask pi to write `a.ts`, then run `tsx a.ts` — it just works.

> Status: **proof of concept**. The SDK core is implemented and unit-tested; the sandbox
> image is built separately (see [The sandbox image](#the-sandbox-image)).

## Monorepo layout

This is a pnpm monorepo with two packages:

```
packages/sdk    → the `wepi` SDK: headless core + React hooks (`@wepi/sdk/react`) + c2w sandbox (`@wepi/sdk/c2w`)
apps/client     → a React + Vite app; the canonical example of consuming the SDK
```

```bash
pnpm install
pnpm -r build          # build every package
pnpm -r typecheck
pnpm --filter @wepi/sdk test
pnpm --filter wepi-client dev   # run the example app
```

## Install

```bash
pnpm add @wepi/sdk          # + react, react-dom if you use @wepi/sdk/react
```

## Use — the core API

```ts
import { createChat } from "@wepi/sdk";

const chat = await createChat({
  apiKey,                                   // or baseUrl / getApiKey — see Networking & keys
  model: "claude-sonnet-4-5",               // optional
  files: { "a.ts": "export const x = 1;" }, // optional: seed the workspace
  persist: "proj-1",                        // optional: resume on reload (IndexedDB by default)
  sandbox,                                  // optional: a Sandbox for the bash tool (see @wepi/sdk/c2w)
});

// send() streams AND awaits — pick one per call.
for await (const text of chat.send("Refactor a.ts")) print(text);  // stream deltas
const reply = await chat.send("Now add a test");                   // -> full string

chat.abort();             // stop the current turn (it resolves; turn.aborted is set)
chat.messages;            // conversation transcript
chat.metrics;             // { turns, tokensIn, tokensOut, costUsd, contextPct }
chat.files();             // read the workspace back -> { path: contents }
chat.fs.onChange(cb);     // observe file changes (live file-tree UIs)
chat.subscribe(cb);       // raw agent events (message/turn/tool lifecycle)
chat.dispose();           // abort + flush a final snapshot
```

One-shot helper: `await ask("Summarize a.ts", { apiKey })`.

### Models — any provider, cloud or local

wepi is model-agnostic. Pick a cloud provider by string id, or inject a pi-ai
`Provider` object for anything else — including a **local model running in the
browser over WebGPU** (no API key, no provider calls).

```ts
// Cloud, by string id — anthropic (default), openai, google, mistral, groq, xai, deepseek, openrouter:
await createChat({ provider: "openai", model: "gpt-5.1",          apiKey });
await createChat({ provider: "google", model: "gemini-2.5-pro",    apiKey });

// Any other pi-ai provider — inject the Provider object (keeps the default bundle lean):
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
await createChat({ provider: deepseekProvider(), model: "deepseek-v4-pro", apiKey });

// Local, in-browser via wllama (llama.cpp/WASM + WebGPU) — keyless, ANY GGUF on HF:
import { createWllamaProvider } from "@wepi/sdk/wllama";
import wasmUrl from "@wllama/wllama/esm/wasm/wllama.wasm?url"; // vite
const { provider, modelId } = await createWllamaProvider({
  repo: "Qwen/Qwen3-1.7B-GGUF", quant: "Q4_K_M",   // day-one GGUF, no precompilation
  wasmUrl,
  onProgress: ({ loaded, total }) => console.log(loaded / total),
});
await createChat({ provider, model: modelId });

// Local, in-browser via WebLLM + WebGPU — keyless (MLC precompiled models only):
import { createWebLLMProvider } from "@wepi/sdk/webllm";
const { provider, modelId } = await createWebLLMProvider({
  model: "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",   // pick a function-calling model
  onProgress: (p) => console.log(p.text),          // weight download / compile progress
});
await createChat({ provider, model: modelId });

// Local, native runtime (Ollama / llama.cpp server / LM Studio) — zero extra code,
// it's just an OpenAI-compatible endpoint:
await createChat({ provider: "openai", model: "qwen3:8b", baseUrl: "http://localhost:11434/v1" });
```

**Which local engine?** `@wepi/sdk/wllama` runs **any GGUF on Hugging Face with zero
conversion** (llama.cpp gets new architectures first, so the latest open-source
models work day-one) and is WebGPU-accelerated since wllama v3.1. `@wepi/sdk/webllm`
only runs MLC-precompiled models — a mature engine, but the newest releases lag.
Both are **optional** peer dependencies (`@wllama/wllama`, `@mlc-ai/web-llm`),
loaded only by their respective modules, and both accept a pre-created `engine`
if you'd rather own the load (recommended with bundlers).

Because the pi agent drives its tools through function calls, choose a model with
real function-calling support (wllama: e.g. Qwen3 or Llama-3.x-Instruct GGUFs;
WebLLM: a Hermes-2-Pro or Llama-3.1-8B FC build); instruct-only models will chat
but won't reliably call tools. wllama notes: single files are capped at 2 GB
(use split GGUF above that), serve with COOP/COEP headers to unlock
multi-threading, and avoid IQ-quants on WASM.

Errors are typed: turns reject with `WepiError` whose `code` is `"auth"`,
`"rate_limit"`, `"provider"`, `"busy"`, … so apps can branch. A second `send()`
while a turn is in flight throws (`code: "busy"`); an aborted turn *resolves*
with the partial text and `turn.aborted === true`.

### Persistence — bring your own store

`persist: "id"` uses the built-in `IndexedDBStore`. To persist anywhere else,
implement the two-method `ChatStore` interface and pass `{ id, store }`:

```ts
import type { ChatStore, ChatSnapshot } from "@wepi/sdk";

class ApiStore implements ChatStore {
  async load(id: string) { return (await fetch(`/api/chats/${id}`)).json(); }
  async save(id: string, snap: ChatSnapshot) {
    await fetch(`/api/chats/${id}`, { method: "PUT", body: JSON.stringify(snap) });
  }
}

const chat = await createChat({ baseUrl: "/api/llm", persist: { id, store: new ApiStore() } });
```

Snapshots (`{ version, messages, files, updatedAt }`) are saved once per
completed turn — never per token — so a network-backed store is cheap.
`updatedAt` supports optimistic concurrency on the server side.

## Use — React (`@wepi/sdk/react`)

Two hooks — the agent and the sandbox as React state, your markup on top:

```tsx
import { usePiChat, useC2wSandbox } from "@wepi/sdk/react";

const c2w = useC2wSandbox();               // boots + warms the bash sandbox
const pi = usePiChat({
  apiKey,
  sandbox: c2w.sandbox,
  enabled: !!c2w.sandbox,                  // hold off until the sandbox exists
});
// pi.transcript, pi.send(text), pi.busy, pi.abort(), pi.files(), pi.chat
```

`react` / `react-dom` are peer dependencies. The bash sandbox needs a
cross-origin-isolated page plus a few app-supplied assets — see below.

## The c2w bash sandbox (`@wepi/sdk/c2w`)

```ts
import { C2wSandbox } from "@wepi/sdk/c2w";
const sandbox = new C2wSandbox({ onLog: console.debug });
const chat = await createChat({ apiKey, sandbox });
```

`C2wSandbox` is a container2wasm Alpine VM that backs pi's `bash` tool. The image
ships **python3, node 20, and TypeScript (`tsc` + `tsx`)** on top of Alpine 3.20
(riscv64). It's exported as **eStargz**, so the in-browser imagemounter
lazy-pulls file chunks over HTTP Range requests — boot downloads only what the
shell touches, not the whole ~45MB image; python/node bits stream in on first
use and are then browser-cached. (The guest has no network — anything else the
agent needs must be baked into the image; see
`packages/sdk/scripts/sandbox.Dockerfile`.)

Semantics worth knowing:

- Commands run in `/workspace` (where the agent's workspace is mirrored) and are
  serialized over one persistent shell — `cd` and env vars carry across calls.
- Each command gets a time budget (`execTimeoutMs`, default 120s) and honors the
  turn's abort. A wedged command marks the sandbox broken; the next exec
  **reboots the VM transparently** (or call `sandbox.reset()` yourself).
- stdout and stderr come back separated, with the real exit code.
- Workspace sync is plain POSIX `sh` over `Sandbox.exec` — any custom `Sandbox`
  implementation (server-side runner, WebContainer, …) gets it for free.

The SDK ships the code; the **host app** supplies the runtime pieces (they're
deployment/CORS concerns, and the wasm/image blobs are too big to live in an
npm tarball):

- the wasm/image assets (`out.wasm.gzip`, `imagemounter.wasm.gzip`, the
  `alpine/` OCI image, `worker.js`, `dist/`) served under one base URL —
  point `assetsBaseUrl` at it (default: the page origin). 
  * **If using Vite (recommended)**: Add the `wepiAssetsPlugin` (from `@wepi/sdk/vite`) to your `vite.config.ts`. It will automatically scan your `src/` directory for sandbox usage (e.g. `C2wSandbox` or `useC2wSandbox`) and download the assets into your `./public` folder at server/build start.
  * **If using other bundlers**: Run **`wepi-fetch-assets ./public`** once to download a prebuilt bundle into that directory (see [The sandbox image](#the-sandbox-image)).
- the xterm-pty + `runcontainer.js` global `<script>`s in `index.html`,
- the cross-origin-isolation headers (see below).

`apps/client` wires all of this up — copy it as a starting point. Importing `@wepi/sdk/c2w` is side-effect free (the globals are looked up at boot), so it's safe in SSR builds.

### Lighter alternative: lifo.sh (`@wepi/sdk/lifo`)

Don't need a real Alpine VM? [lifo.sh](https://lifo.sh) (`@lifo-sh/core`, MIT) is a
Linux-*like* OS reimplemented in pure TypeScript — virtual filesystem, bash-like
shell, and 60+ Unix commands, all client-side. `LifoSandbox` is a drop-in
`Sandbox` with none of c2w's hosting burden: **no COOP/COEP headers, no global
`<script>`s, no image download** — just an optional peer dependency.

```ts
import { LifoSandbox } from "@wepi/sdk/lifo";      // npm i @lifo-sh/core
const chat = await createChat({ apiKey, sandbox: new LifoSandbox() });
```

In React it's the same shape as `useC2wSandbox`, so it's a one-line swap:
`const lifo = useLifoSandbox();` → `usePiChat({ apiKey, sandbox: lifo.sandbox, enabled: !!lifo.sandbox })`.
The trade-off: lifo runs its own reimplemented commands, not a real userland, so
some commands differ or are absent. See [the sandbox guide](docs/guides/sandbox.md).

## How it works

```
Main thread                                Web Worker
 Agent loop (pi-agent-core, native JS)      container2wasm Alpine VM
  ├─ model calls → fetch → LLM API           └─ /bin/sh on a raw PTY
  ├─ file tools → VirtualFS (in-memory)          ↑ bash commands, file-framed
  └─ bash tool ──sync /workspace──────────────────┘ (base64 in/out, sentinel-fenced)
       VirtualFS ↔ snapshots ↔ ChatStore (IndexedDB / your backend)
```

The agent is **not** emulated — it's ordinary JavaScript with full-speed model
streaming. Only shell execution pays the wasm tax, and prompt-injected commands
are contained: the VM has no network and no host filesystem.

## ⚠️ Cross-origin isolation is required (for the sandbox)

The VM's tty bridge uses `SharedArrayBuffer`, which the browser only exposes
when the page is **cross-origin isolated**. Serve your app with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless   # or require-corp
```

(`credentialless` lets CDN scripts load without CORP headers; the example app
uses it — see `apps/client/vite.config.ts`.) Chats without a sandbox (file
tools only) don't need any of this.

## The sandbox image

The bash sandbox assets — the emulator wasm, the image mounter, and the Alpine
OCI rootfs — are **fetched on demand**, not committed.

* **Vite apps**: Add `wepiAssetsPlugin` to `vite.config.ts` (see above). The plugin automatically downloads the assets when the server starts or builds if C2wSandbox is used.
* **Non-Vite apps**: Run the CLI script:
```bash
wepi-fetch-assets ./public            # into your app's served dir
```

This pulls a pinned `wepi-sandbox-assets-<version>.tar.gz` from the SDK's
GitHub release (`--tag`/`--repo`/`--url` override the source; `--force`
refetches). The bundle's prebuilt `alpine/` is the default rootfs — no Docker
needed.

To **change what's inside** the sandbox, edit the recipe that ships with the
SDK — `packages/sdk/scripts/sandbox.Dockerfile` — and rebuild just the rootfs:

```
wepi-build-image ./public/alpine      # requires Docker Desktop
```

(The build runs riscv64 packages under QEMU, so it takes a few minutes. The
recipe lives next to `C2wSandbox` because its arch/eStargz/toolchain choices are
dictated by that loader — see the header comment in `build-image.mjs`.)

## Networking & keys

Three ways to authenticate, in order of production-readiness:

```ts
createChat({ baseUrl: "/api/llm" });         // ✅ production: your proxy injects the key
createChat({ getApiKey: () => mintToken() }); // short-lived tokens from your backend
createChat({ apiKey });                       // POC: browser-direct (key lives in the page)
```

Browser-direct calls are subject to CORS — providers must allow browser access
(e.g. Anthropic's `anthropic-dangerous-direct-browser-access`). A `baseUrl`
proxy sidesteps CORS entirely and keeps the key server-side.

## Deferred (not in the POC)

`steer` / `follow_up` mid-turn, conversation `fork`, deletion propagation in
workspace sync (files deleted in the VM aren't removed from the workspace),
binary files in the workspace (string contents only), a wsProxy TCP transport,
and live workspace read-back *during* a running turn.

## Develop

```bash
pnpm install
pnpm -r typecheck
pnpm --filter @wepi/sdk test   # offline core: Turn semantics, fs sync, busy guard, persistence
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the checks CI runs, and please follow our [Code of Conduct](CODE_OF_CONDUCT.md).
For security issues, see [SECURITY.md](SECURITY.md) rather than filing a public
issue.

## License

Licensed under the [MIT License](LICENSE).

wepi builds on and bundles third-party software (pi/pi-agent-core,
container2wasm, Alpine, and optional in-browser inference engines); see
[NOTICE](NOTICE) for attribution. Those components remain under their own
licenses.
