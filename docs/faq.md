# FAQ & troubleshooting

## General

### Does anything run on a server?

No — the agent, model streaming, and file tools are all client-side JavaScript.
The only optional server piece is a proxy you might add for API keys
([Networking & keys](guides/networking-and-keys.md)). The `bash` sandbox runs in
a Web Worker on the page, not on a server.

### Is my code sent anywhere?

Cloud models receive the conversation and any file content the agent includes,
like any LLM API. With a **local model** ([Local models](guides/local-models.md))
nothing leaves the page. The bash sandbox has no network, so shell commands can't
exfiltrate anything.

### Can I use it without the bash sandbox?

Yes. Omit `sandbox` and the agent still reads, writes, edits, lists, and greps
files in the virtual workspace. Only shell commands are unavailable, and you skip
all the cross-origin-isolation hosting requirements.

## Models

### "unknown provider" / "unknown model"

`buildModel` throws a `WepiError` (code `unknown`) with the valid options when a
provider or model id isn't recognized. Check the id against
[Models & providers](guides/models.md), or pass a pi-ai `Provider` / `Model`
object directly.

### "no credentials — pass apiKey, getApiKey, or baseUrl"

A cloud provider needs a credential. Supply one of the three, or use a local
model (which is keyless). See [Networking & keys](guides/networking-and-keys.md).

### My local model chats but never edits files or runs bash

It's almost certainly not a function-calling model. The agent drives tools
through function calls, so pick an FC-capable model: Qwen3 / Llama-3.x-Instruct /
Hermes GGUFs for wllama, one of the five Hermes builds for WebLLM, or Gemma 4 via
LiteRT. See [Local models](guides/local-models.md).

### wllama: "No GGUF file found"

The `quant` you asked for isn't in that repo. Some repos ship a single quant
(e.g. Qwen's official `Qwen/Qwen3-*-GGUF` ship only `Q8_0`). Pin a `quant`/`file`
the repo actually contains.

### WebLLM: "not supported for ChatCompletionRequest.tools"

You picked a model outside WebLLM's function-calling allowlist. Use one of the
five Hermes builds (e.g. `Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC`).

## Sandbox

### The sandbox never becomes ready / SharedArrayBuffer is undefined

Your page isn't cross-origin isolated. Serve it with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

and make sure the runtime assets and global `<script>`s are in place. See
[The bash sandbox](guides/sandbox.md).

### A command hung and now bash misbehaves

A wedged command marks the sandbox broken; the **next** `exec` transparently
reboots the VM. You can also force it with `sandbox.reset()`. Long commands are
bounded by `execTimeoutMs` (default 120 s) and honor the turn's abort.

### Files created in bash don't show up (or deletions don't stick)

Workspace sync mirrors dirty files in and reads `/workspace` back around each
command. Two POC limits: **deleted files aren't propagated** back out of the VM,
and **binary files aren't synced** (string contents only). See
[Architecture](architecture.md#workspace-sync).

## Turns & concurrency

### `send()` threw with code `busy`

Only one turn runs per `Chat` at a time. Await the current turn or call
`chat.abort()` before sending again. In React, `usePiChat().send()` returns
`false` instead of throwing.

### I aborted a turn but it didn't throw

That's by design — an aborted turn **resolves** with the partial text. Check
`turn.aborted`. See [Error handling](guides/error-handling.md).

## Persistence

### My conversation didn't survive a reload

Set `persist` with a stable id. Without it, nothing is saved. Snapshots are
written after each completed turn; an in-progress turn isn't yet persisted.

### Two tabs are clobbering each other's history

Use `updatedAt` for optimistic concurrency in your `ChatStore.save`, or give each
tab a distinct id. See [Persistence](guides/persistence.md#optimistic-concurrency).

## React

### Changing the model wiped my transcript

`usePiChat` re-creates the `Chat` when an agent-defining option changes, resetting
message history. The on-screen transcript is display-only; use `persist` to carry
real state across re-creations. See [React bindings](guides/react.md).

## Still stuck?

- Re-read the [Architecture](architecture.md) overview — most surprises come from
  the workspace/sandbox sync model.
- Check the `apps/client` example, which wires up every piece end to end.
