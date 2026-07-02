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
packages/sdk    → the `wepi` SDK: headless core + React bindings (`wepi/react`) + c2w sandbox (`wepi/c2w`)
apps/client     → a React + Vite app; the canonical example of consuming the SDK
```

```bash
pnpm install
pnpm -r build          # build every package
pnpm -r typecheck
pnpm --filter wepi test
pnpm --filter wepi-client dev   # run the example app
```

## Install

```bash
pnpm add wepi          # + react, react-dom if you use wepi/react
```

## Use — the core API

```ts
import { createChat } from "wepi";

const chat = await createChat({
  apiKey,                                   // or baseUrl / getApiKey — see Networking & keys
  model: "claude-sonnet-4-5",               // optional
  files: { "a.ts": "export const x = 1;" }, // optional: seed the workspace
  persist: "proj-1",                        // optional: resume on reload (IndexedDB by default)
  sandbox,                                  // optional: a Sandbox for the bash tool (see wepi/c2w)
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

Errors are typed: turns reject with `WepiError` whose `code` is `"auth"`,
`"rate_limit"`, `"provider"`, `"busy"`, … so apps can branch. A second `send()`
while a turn is in flight throws (`code: "busy"`); an aborted turn *resolves*
with the partial text and `turn.aborted === true`.

### Persistence — bring your own store

`persist: "id"` uses the built-in `IndexedDBStore`. To persist anywhere else,
implement the two-method `ChatStore` interface and pass `{ id, store }`:

```ts
import type { ChatStore, ChatSnapshot } from "wepi";

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

## Use — React (`wepi/react`)

A drop-in component. It boots the c2w bash sandbox for you (see below), so pi can
run shell commands out of the box:

```tsx
import { PiChat } from "wepi/react";
import "wepi/react/PiChat.css";            // optional default styling

<PiChat apiKey={key} files={{ "README.md": "# my project\n" }} persist="proj-1" />
```

Or compose your own UI with the hooks — same agent, your markup:

```tsx
import { usePiChat, useC2wSandbox } from "wepi/react";

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

## The c2w bash sandbox (`wepi/c2w`)

```ts
import { C2wSandbox } from "wepi/c2w";
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
`apps/client/scripts/sandbox.Dockerfile`.)

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
deployment/CORS concerns, not shippable in an npm package):

- the xterm-pty + `runcontainer.js` global `<script>`s in `index.html`,
- the wasm/image assets (`out.wasm.gzip`, `imagemounter.wasm.gzip`, the
  `alpine/` OCI image, `worker.js`, `dist/`) served under one base URL —
  point `assetsBaseUrl` at it (default: the page origin),
- the cross-origin-isolation headers (see below).

`apps/client` wires all of this up — copy it as a starting point. Importing
`wepi/c2w` is side-effect free (the globals are looked up at boot), so it's
safe in SSR builds.

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

The bash sandbox assets ship prebuilt in `apps/client/public`. To change what's
inside the sandbox, edit `apps/client/scripts/sandbox.Dockerfile` and rerun
`node apps/client/scripts/build-image.mjs` (requires Docker Desktop; the build
runs riscv64 packages under QEMU, so it takes a few minutes).

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
pnpm --filter wepi test   # offline core: Turn semantics, fs sync, busy guard, persistence
```

## License

MIT
