# @wepi/sdk

Run the [**pi**](https://github.com/earendil-works/pi) coding agent **natively in the
browser** — no backend. The agent loop runs as ordinary JavaScript on the page; only the
`bash` tool's commands execute inside a
[container2wasm](https://github.com/container2wasm/container2wasm) Alpine VM in a Web
Worker. The agent's workspace is mirrored into the VM around every shell command, so file
tools and `bash` see **one filesystem**: ask pi to write `a.ts`, then run `tsx a.ts` — it
just works.

> ### Status: 0.x proof of concept
>
> The core is implemented and unit-tested (90 tests), but those tests run against mocked
> engines and sandboxes — no test here boots a real VM or calls a real model. The API
> **will** break within 0.x; pin an exact version. Two things in particular to know before
> you build on it:
>
> - **The bash sandbox needs assets that are not in this package.** `@wepi/sdk/c2w` pulls
>   a ~45 MB runtime bundle at build time and needs global `<script>`s on the page; see
>   [The bash sandbox](#the-bash-sandbox) below.
> - **Sandbox assets must be served from your origin root.** The container2wasm worker
>   resolves its helper at `location.origin + "/dist/worker-util.js"`, so serving them
>   under a sub-path will not work today.
>
> The headless core (`createChat` with file tools only) has neither constraint.

## Install

```bash
npm install @wepi/sdk
```

Everything beyond the core is an **optional peer dependency** — install only what you use:

| If you use | Also install |
| --- | --- |
| `@wepi/sdk/react` | `react`, `react-dom` (>=18) |
| `@wepi/sdk/lifo` | `@lifo-sh/core` |
| `@wepi/sdk/wllama` | `@wllama/wllama` |
| `@wepi/sdk/webllm` | `@mlc-ai/web-llm` |
| `@wepi/sdk/litert` | `@litert-lm/core` |
| `@wepi/sdk/vite` | `vite` (>=5) |

## Use

```ts
import { createChat } from "@wepi/sdk";

const chat = await createChat({ apiKey });          // Claude by default
const reply = await chat.send("Create hello.ts");   // await the full reply
for await (const t of chat.send("Add a test")) ...  // or stream it
chat.files();                                       // read the workspace back
```

`send()` both streams and awaits — pick one per call. Also on `Chat`: `abort()`,
`messages`, `metrics`, `fs.onChange()`, `subscribe()`, `dispose()`. For a single
question, `ask(message, options)` creates a chat, sends once, and disposes for you.

## Entry points

| Import | Purpose |
| --- | --- |
| `@wepi/sdk` | Headless core: `createChat`, `Chat`, `ask`, models, errors, stores. |
| `@wepi/sdk/react` | React hooks — `usePiChat`, `useC2wSandbox`, `useLifoSandbox`. No components. |
| `@wepi/sdk/c2w` | The container2wasm bash sandbox. |
| `@wepi/sdk/lifo` | The [lifo.sh](https://lifo.sh) bash sandbox — lighter, needs no asset bundle. |
| `@wepi/sdk/wllama` | On-device models via llama.cpp/WASM — any GGUF on Hugging Face. |
| `@wepi/sdk/webllm` | On-device models via WebLLM (MLC-precompiled only). |
| `@wepi/sdk/litert` | On-device Gemma 4 via Google's LiteRT-LM. |
| `@wepi/sdk/vite` | Vite plugin that fetches the sandbox assets automatically. |

Importing `@wepi/sdk/c2w` is side-effect free (globals are looked up at boot), so it is
safe in SSR builds.

## The bash sandbox

The sandbox assets — the emulator wasm, the image mounter, and the Alpine rootfs — are
**fetched on demand**, not shipped in this package.

```bash
npx wepi-fetch-assets ./public      # into your app's served directory
```

Vite users can skip the CLI and add `wepiAssetsPlugin` from `@wepi/sdk/vite` to
`vite.config.ts`; it fetches the assets on dev-server start and on build, but only when it
detects `C2wSandbox` in your source.

Your page must also be **cross-origin isolated** for the tty bridge to use
`SharedArrayBuffer`:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless   # or require-corp
```

If that is more than you want to take on, `@wepi/sdk/lifo` implements the same `Sandbox`
interface with no asset bundle and no cross-origin isolation requirement.

## Documentation

Full guides live in the repository:
[getting started](https://github.com/nimrod4278/webpi/blob/main/docs/getting-started.md) ·
[API reference](https://github.com/nimrod4278/webpi/blob/main/docs/api-reference.md) ·
[models](https://github.com/nimrod4278/webpi/blob/main/docs/guides/models.md) ·
[local models](https://github.com/nimrod4278/webpi/blob/main/docs/guides/local-models.md) ·
[sandbox](https://github.com/nimrod4278/webpi/blob/main/docs/guides/sandbox.md) ·
[persistence](https://github.com/nimrod4278/webpi/blob/main/docs/guides/persistence.md) ·
[architecture](https://github.com/nimrod4278/webpi/blob/main/docs/architecture.md)

## License

MIT © Nimrod Feldman. Bundles and builds on third-party software; see
[NOTICE](https://github.com/nimrod4278/webpi/blob/main/NOTICE).
