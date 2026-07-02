# The bash sandbox (`wepi/c2w`)

The `bash` tool needs somewhere to run shell commands. In the browser, that is
`C2wSandbox` — a [container2wasm](https://github.com/container2wasm/container2wasm)
Alpine VM running in a Web Worker. This page covers wiring it up, what the image
contains, its runtime semantics, and the hosting requirements.

## Attaching it

```ts
import { createChat } from "wepi";
import { C2wSandbox } from "wepi/c2w";

const sandbox = new C2wSandbox({ onLog: console.debug });
const chat = await createChat({ apiKey, sandbox });

await chat.send("Create fib.py, run it with python3, and print the result");
```

Without a sandbox, `createChat` wires a `NullSandbox`: file tools work and
`bash` returns exit code 127 with a "shell unavailable" message. So a chat that
only reads/writes/greps files needs **none** of the setup below.

## What's in the image

The image is Alpine 3.20 (riscv64) with **python3, node 20, and TypeScript
(`tsc` + `tsx`)** baked in. It is exported as **eStargz**, so the in-browser
imagemounter lazy-pulls file chunks over HTTP Range requests — boot downloads
only what the shell touches, not the whole ~45 MB image. The python and node
bits stream in on first use and are then browser-cached.

The guest has **no network**. Anything else the agent needs must be baked into
the image — edit `apps/client/scripts/sandbox.Dockerfile` and rebuild (see
below).

## Runtime semantics

- **One persistent shell.** Commands run in `/workspace` (where the agent's
  workspace is mirrored) and are serialized over a single shell, so `cd` and
  environment variables carry across calls.
- **Time budget.** Each command has an `execTimeoutMs` (default 120 s) and honors
  the turn's abort signal.
- **Separated output.** `stdout` and `stderr` come back separate, with the real
  exit code.
- **Self-healing.** A wedged command marks the sandbox broken; the next `exec`
  transparently reboots the VM (or call `sandbox.reset()` yourself). Recovery
  first tries a `^C` + probe (usually under a second) before falling back to a
  full reboot.
- **Framing.** The tty bridge uses a base64, `$M`-expanded sentinel-fenced
  protocol so terminal echo cannot fake a command boundary.

## Workspace sync

The agent's file tools operate on the in-memory `VirtualFS`; `bash` operates on
`/workspace`. wepi mirrors dirty files in before each command and reads
`/workspace` back after — using pure-POSIX `sh` over `Sandbox.exec` alone, so the
mechanism works with **any** `Sandbox` implementation. Two limits are deliberate
in the POC: **deleted files aren't propagated** back out of the VM, and **binary
files aren't synced** (string contents only). See [Architecture](../architecture.md).

## Hosting requirements

The SDK ships the code; the **host app** supplies the runtime pieces, because
they're deployment/CORS concerns that can't live in an npm package:

1. **Cross-origin isolation.** The tty bridge uses `SharedArrayBuffer`, which the
   browser only exposes on a cross-origin-isolated page. Serve your app with:

   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: credentialless   # or require-corp
   ```

   `credentialless` lets CDN scripts load without CORP headers. Chats without a
   sandbox (file tools only) don't need any of this.

2. **The global `<script>`s** — xterm-pty + `runcontainer.js` — in your
   `index.html`.

3. **The wasm/image assets** served under one base URL: `out.wasm.gzip`,
   `imagemounter.wasm.gzip`, the `alpine/` OCI image, `worker.js`, and `dist/`.
   Point `assetsBaseUrl` at that URL (default: the page origin).

`apps/client` wires all of this up end to end — copy it as a starting point.
Importing `wepi/c2w` is side-effect-free (the globals are looked up at boot), so
it is safe in SSR builds.

## Rebuilding the image

The prebuilt assets live in `apps/client/public`. To change what's inside the
sandbox, edit `apps/client/scripts/sandbox.Dockerfile` and rerun:

```bash
node apps/client/scripts/build-image.mjs
```

This requires Docker Desktop and runs riscv64 packages under QEMU, so it takes a
few minutes.

## In React

`useC2wSandbox` handles the boot + warm-up lifecycle and hands you a `sandbox` to
pass into `usePiChat`/`createChat`:

```tsx
import { useC2wSandbox, usePiChat } from "wepi/react";

const c2w = useC2wSandbox();               // boots + warms the VM
const pi = usePiChat({
  apiKey,
  sandbox: c2w.sandbox,
  enabled: !!c2w.sandbox,                  // hold off until it exists
});
```

`c2w.status` walks `idle → booting → warming → ready → error`, and `c2w.log`
carries the latest lifecycle line for a status display. See
[React bindings](react.md).

## Writing your own `Sandbox`

The interface is one method:

```ts
interface Sandbox {
  exec(command: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ExecResult>;
}
interface ExecResult { stdout: string; stderr: string; code: number; }
```

Implement `exec` against a server-side runner, a WebContainer, or a remote VM and
pass it as `sandbox`. Workspace sync comes for free because it is built on `exec`
alone.

## See also

- [Architecture](../architecture.md) — sync protocol and the `Sandbox` seam.
- [Local models](local-models.md) — same COOP/COEP headers, for WebGPU.
- [FAQ & troubleshooting](../faq.md) — sandbox errors and fixes.
