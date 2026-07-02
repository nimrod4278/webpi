# wepi documentation

**Run the [pi](https://github.com/earendil-works/pi) coding agent natively in the browser — no backend.**

wepi is a headless SDK plus React bindings for embedding a real coding agent in a
web page. The agent loop ([pi-agent-core](https://github.com/earendil-works/pi))
runs as ordinary JavaScript; only the `bash` tool's commands execute inside a
[container2wasm](https://github.com/container2wasm/container2wasm) Alpine VM in a
Web Worker. File tools and shell commands share **one filesystem**, so you can
ask pi to write `a.ts` and then run `tsx a.ts` in the same turn.

> **Status: proof of concept.** The SDK core is implemented and unit-tested. The
> bash sandbox image is built separately. Interfaces may still change before 1.0.

---

## Documentation map

### Start here

| Page | What it covers |
| --- | --- |
| [Introduction](introduction.md) | What wepi is, how the pieces fit, and when to use it. |
| [Getting started](getting-started.md) | Install, first chat, streaming vs. awaiting a reply. |
| [Architecture](architecture.md) | The agent loop, the workspace, the sandbox, and the sync model. |

### Guides

| Page | What it covers |
| --- | --- |
| [Models & providers](guides/models.md) | Cloud providers by id, custom providers, choosing a model. |
| [Local models in the browser](guides/local-models.md) | `wllama`, `webllm`, and `litert` — keyless inference over WebGPU. |
| [The bash sandbox](guides/sandbox.md) | `C2wSandbox`, cross-origin isolation, and hosting the runtime assets. |
| [Persistence](guides/persistence.md) | Resume on reload, the `ChatStore` seam, remote backends. |
| [React bindings](guides/react.md) | `<PiChat>`, `usePiChat`, and `useC2wSandbox`. |
| [Networking & API keys](guides/networking-and-keys.md) | Proxy, short-lived tokens, and browser-direct trade-offs. |
| [Error handling](guides/error-handling.md) | `WepiError`, error codes, abort semantics. |

### Reference

| Page | What it covers |
| --- | --- |
| [API reference](api-reference.md) | Every export: functions, classes, options, and types. |
| [FAQ & troubleshooting](faq.md) | Common questions and errors, with fixes. |

---

## The 60-second version

```bash
pnpm add wepi
```

```ts
import { createChat } from "wepi";

const chat = await createChat({
  apiKey,                                   // or baseUrl / getApiKey
  model: "claude-sonnet-4-5",               // optional
  files: { "a.ts": "export const x = 1;" }, // optional: seed the workspace
  persist: "proj-1",                        // optional: resume on reload
});

// send() streams AND awaits — pick one per call:
for await (const text of chat.send("Refactor a.ts")) print(text);
const reply = await chat.send("Now add a test");

chat.files();      // read the workspace back -> { path: contents }
chat.metrics;      // { turns, tokensIn, tokensOut, costUsd, contextPct }
```

Continue with **[Getting started](getting-started.md)**.

---

## License

MIT
