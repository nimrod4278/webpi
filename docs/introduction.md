# Introduction

wepi runs the **pi** coding agent entirely inside a browser tab. There is no
server component to the agent: the agent loop, the model streaming, and the file
tools are all plain JavaScript running on the page. The only piece that leaves
JavaScript is the `bash` tool, whose commands run in a WebAssembly Linux VM in a
Web Worker.

## What you get

- **A real coding agent, client-side.** pi reads, writes, edits, lists, and
  greps files in a virtual workspace, and runs shell commands — driven by a
  model through function calls.
- **One filesystem across tools.** The in-memory workspace is mirrored into the
  sandbox around every shell command, so files written by the `write` tool are
  visible to `bash`, and files created by `bash` are read back by `read`.
- **Any model.** Cloud providers (Anthropic, OpenAI, Google, Mistral, Groq, xAI,
  DeepSeek, OpenRouter) by string id, any other pi-ai provider by object, or a
  **local model running over WebGPU** with no API key.
- **Streaming and awaiting from one call.** `chat.send()` returns a value that is
  both an async iterable of text deltas and a promise for the full reply.
- **Optional persistence.** Snapshot the conversation and workspace to IndexedDB
  (built in) or to any backend you implement.
- **A React layer.** A drop-in `<PiChat>` component, or hooks to build your own
  UI over the same agent.

## The mental model

```
Main thread                                Web Worker
 Agent loop (pi-agent-core, native JS)      container2wasm Alpine VM
  ├─ model calls → fetch → LLM API           └─ /bin/sh on a raw PTY
  ├─ file tools → VirtualFS (in-memory)          ↑ bash commands, file-framed
  └─ bash tool ──sync /workspace──────────────────┘ (base64 in/out, fenced)
       VirtualFS ↔ snapshots ↔ ChatStore (IndexedDB / your backend)
```

The agent is **not emulated** — it is ordinary JavaScript with full-speed model
streaming. Only shell execution pays the WebAssembly tax, and prompt-injected
commands are contained: the VM has no network and no host filesystem.

See [Architecture](architecture.md) for the full breakdown.

## When to use wepi

wepi is a good fit when you want an agentic coding experience **in the browser**
without standing up an execution backend:

- In-app "ask the agent to edit my project" features.
- Playgrounds, tutorials, and interactive docs that run code.
- Privacy-sensitive or offline demos using a local model — no data leaves the
  page.

It is **not** a fit when you need heavy compute, real network access from the
shell, or long-running background jobs — the sandbox is a lightweight,
network-less VM meant for quick, deterministic shell steps.

## Packages and entry points

wepi is published as a single package with several subpath exports:

| Import | Purpose |
| --- | --- |
| `wepi` | Headless core: `createChat`, `Chat`, `ask`, models, errors, stores. |
| `wepi/react` | React component and hooks. |
| `wepi/c2w` | The container2wasm bash sandbox. |
| `wepi/wllama` | Local models via llama.cpp/WASM (any GGUF). |
| `wepi/webllm` | Local models via WebLLM (MLC-precompiled). |
| `wepi/litert` | Local Gemma 4 via Google's LiteRT-LM. |

Continue with **[Getting started](getting-started.md)**.
