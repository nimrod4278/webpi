# wepi

Chat with the [**pi**](https://github.com/earendil-works/pi) coding agent **entirely in the
browser** — no backend. `wepi` boots a [container2wasm](https://github.com/container2wasm/container2wasm)-converted
image (minimal Node + pi) in a Web Worker and drives it over pi's RPC protocol.

> Status: **proof of concept**. The SDK core is implemented and unit-tested; the
> `pi.wasm` image is built separately (see [Building the image](#building-the-image)).

## Monorepo layout

This is a pnpm monorepo with two packages:

```
packages/sdk    → the `wepi` SDK: headless core + React components (`wepi/react`) + c2w sandbox (`wepi/c2w`)
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

## Use — the entire API

```ts
import { createChat } from "wepi";

const chat = await createChat({
  apiKey,                                   // required
  model: "claude-opus-4-8",                 // optional
  files: { "a.ts": "export const x = 1;" }, // optional: seed the workspace
  persist: "proj-1",                        // optional: IndexedDB id; reload to resume
  onLog: console.debug,                     // optional: boot/stderr/lifecycle logs
});

// send() streams AND awaits — pick one per call.
for await (const text of chat.send("Refactor a.ts")) print(text);  // stream deltas
const reply = await chat.send("Now add a test");                   // -> full string

chat.abort();             // stop the current turn
chat.messages;            // conversation history
chat.metrics;             // { bootMs, tokensIn, tokensOut, costUsd, contextPct }
await chat.files();       // read workspace back -> { path: contents }
chat.dispose();           // tear down the worker
```

One-shot helper: `await ask("Summarize a.ts", { apiKey })`.

## Use — React (`wepi/react`)

A drop-in component. It boots the c2w bash sandbox for you (see below), so pi can
run shell commands out of the box:

```tsx
import { PiChat } from "wepi/react";
import "wepi/react/PiChat.css";            // optional default styling

<PiChat apiKey={key} files={{ "README.md": "# my project\n" }} />
```

Or compose your own UI with the hooks — same agent, your markup:

```tsx
import { usePiChat, useC2wSandbox } from "wepi/react";

const c2w = useC2wSandbox();               // boots + warms the bash sandbox
const pi = usePiChat({ apiKey, sandbox: c2w.sandbox });
// pi.transcript, pi.send(text), pi.busy, pi.abort(), pi.files()
```

`react` / `react-dom` are peer dependencies. The bash sandbox needs a
cross-origin-isolated page plus a few app-supplied assets — see below.

## The c2w bash sandbox (`wepi/c2w`)

`PiChat`/`useC2wSandbox` use `C2wSandbox`, a container2wasm Alpine VM that backs
pi's `bash` tool. The SDK ships the code; the **host app** supplies the runtime
pieces (they're deployment/CORS concerns, not shippable in an npm package):

- the xterm-pty + `runcontainer.js` global `<script>`s in `index.html`,
- the wasm/image assets in `public/` (`out.wasm.gzip`, `imagemounter.wasm.gzip`,
  the `alpine/` OCI image, `worker.js`, `dist/`),
- the cross-origin-isolation headers (see below).

`apps/client` wires all of this up — copy it as a starting point.

## How it works

```
Main thread (Chat)                 Web Worker
 createChat() ──postMessage──────▶ browser_wasi_shim + pi.wasm
 chat.send() → stream|await         fd0=stdin fd1=stdout (RPC JSONL)
 stdin via SharedArrayBuffer        fd2=stderr → onLog
                                    net=browser Fetch → LLM API
                                    workspace dir (seed/read) ↔ IndexedDB
```

pi runs in `--mode rpc`, speaking LF-delimited JSON over stdin/stdout. The SDK is a
thin bridge: `send()` issues an RPC `prompt`, yields `text_delta`s as they stream,
and resolves on `agent_end`.

## ⚠️ Cross-origin isolation is required

Blocking stdin in the worker uses `SharedArrayBuffer` + `Atomics.wait`, which the
browser only exposes when the page is **cross-origin isolated**. Serve your app with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The example app (`apps/client`) sets these for you.

## Building the image

Requires Docker and [`c2w`](https://github.com/container2wasm/container2wasm/releases).

```bash
PI_VERSION=latest ./build/build.sh   # -> dist/pi.wasm
```

This bundles pi to a single file (esbuild), strips a minimal Alpine base, and
converts to a **WASI-target** `.wasm` (which gets container2wasm's **wizer kernel
pre-boot** for faster cold start). Point the SDK at it via `createChat({ image })`,
or publish it and update `DEFAULT_IMAGE_URL` in `src/image.ts`.

## Run the demo

```bash
pnpm install
pnpm --filter wepi build              # build the SDK (so wepi/react resolves)
pnpm --filter wepi-client dev         # http://localhost:5173
```

The bash sandbox assets ship in `apps/client/public`; rebuild them from a fresh
image with `apps/client/scripts/build-image.mjs` if needed.

## Networking & keys

POC uses `net=browser`: the in-wasm network stack forwards HTTPS via the browser's
`fetch`. This is subject to CORS — providers must allow browser access (e.g.
Anthropic's `anthropic-dangerous-direct-browser-access`). The API key lives in the
browser. A `wsProxy` transport (full TCP/IP, CORS-free, server-side key injection)
is the planned production path — see the `Transport` seam in `src/worker/net.ts`.

## Deferred (not in the POC)

`steer` / `follow_up`, conversation `fork`, multi-session listing, `wsProxy`
transport, raw-event subscription, and **live workspace read-back during a running
turn** (today `chat.files()` reads the latest persisted snapshot; a 2-worker design
is needed to snapshot mid-run while the runtime worker is blocked on stdin).

## Develop

```bash
pnpm install
pnpm -r typecheck
pnpm --filter wepi test   # pure core: framing, RPC correlation, Turn stream/await
```

## License

MIT
