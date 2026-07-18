# Getting started

This page takes you from install to a working chat, streaming, reading the
workspace back, and running shell commands.

## Prerequisites

- A modern browser. For the bash sandbox you additionally need a
  **cross-origin-isolated** page (see [The bash sandbox](guides/sandbox.md)); for
  local models you need **WebGPU**.
- Node and pnpm if you are building the example app from the monorepo.
- Credentials for a cloud model — an API key, a proxy `baseUrl`, or a token
  minter. Local models need none. See [Networking & keys](guides/networking-and-keys.md).

## Install

```bash
pnpm add @wepi/sdk
# add react + react-dom too if you will use @wepi/sdk/react
pnpm add react react-dom
```

## Your first chat

```ts
import { createChat } from "@wepi/sdk";

const chat = await createChat({
  apiKey: import.meta.env.VITE_ANTHROPIC_KEY, // POC: browser-direct
  model: "claude-sonnet-4-5",                 // optional, this is the default
  files: { "a.ts": "export const x = 1;" },   // optional: seed the workspace
});

const reply = await chat.send("Add a doc comment to a.ts");
console.log(reply);
console.log(chat.files()["a.ts"]); // the edited file
```

`createChat` is async because it restores any persisted snapshot before
returning. Without `persist`, it resolves immediately.

## Streaming vs. awaiting

`chat.send()` returns a `Turn`, which is **both** an async iterable of text
deltas **and** a promise for the full reply. Pick one per call:

```ts
// Stream deltas as they arrive:
for await (const delta of chat.send("Explain a.ts line by line")) {
  process.stdout.write(delta);
}

// Or await the whole thing:
const full = await chat.send("Now summarize it in one sentence");
```

Do not do both on the same call — iterate it or await it, not both.

## Observing tool calls

Pass `onTool` to watch the agent's tool activity (useful for a UI that shows
"running `bash`…"):

```ts
await chat.send("Run the tests", {
  onTool: (e) => {
    if (e.type === "start") console.log("→", e.toolName, e.args);
    else console.log("←", e.toolName, e.isError ? "error" : "ok");
  },
});
```

## Adding shell commands

By default the `bash` tool reports that it is unavailable (a `NullSandbox` is
wired). To let pi run shell commands, attach a sandbox. In the browser, that is
`C2wSandbox` from `@wepi/sdk/c2w`:

```ts
import { createChat } from "@wepi/sdk";
import { C2wSandbox } from "@wepi/sdk/c2w";

const sandbox = new C2wSandbox({ onLog: console.debug });
const chat = await createChat({ apiKey, sandbox });

await chat.send("Create fib.py, run it with python3, and show the output");
```

The sandbox has some hosting requirements (cross-origin isolation and a few
runtime assets). See **[The bash sandbox](guides/sandbox.md)** before shipping it.

## Persisting across reloads

Give the chat a stable id and it saves a snapshot after every completed turn,
restoring it the next time you create a chat with the same id:

```ts
const chat = await createChat({ apiKey, persist: "project-42" });
```

By default this uses IndexedDB. To store snapshots on your own backend, see
**[Persistence](guides/persistence.md)**.

## Reading state back

```ts
chat.messages;           // the conversation transcript (read-only)
chat.metrics;            // { turns, tokensIn, tokensOut, costUsd, contextPct }
chat.files();            // the workspace -> { path: contents }
chat.fs.onChange(cb);    // observe file changes (for a live file tree)
chat.subscribe(cb);      // raw agent events (message/turn/tool lifecycle)
```

## Cleaning up

```ts
chat.abort();    // stop the in-flight turn (it resolves; turn.aborted is set)
chat.dispose();  // abort + flush a final snapshot
```

## One-shot helper

For a single question with no follow-ups:

```ts
import { ask } from "@wepi/sdk";

const answer = await ask("Summarize a.ts", {
  apiKey,
  files: { "a.ts": source },
});
```

`ask` creates a chat, sends one message, and disposes it for you.

## Using React instead

If you are building a UI, the React layer is usually the fastest path:

```tsx
import { usePiChat } from "@wepi/sdk/react";

function Chat({ apiKey }: { apiKey: string }) {
  const pi = usePiChat({ apiKey, files: { "README.md": "# my project\n" }, persist: "proj-1" });
  return (
    <button disabled={!pi.ready || pi.busy} onClick={() => pi.send("Add a test")}>
      Send
    </button>
  );
}
```

The React layer is hooks only — bring your own markup. See **[React
bindings](guides/react.md)** for the full hook surface.

## Next steps

- Understand the internals: [Architecture](architecture.md).
- Pick a model: [Models & providers](guides/models.md).
- Run inference on-device: [Local models](guides/local-models.md).
- Go to production with keys: [Networking & keys](guides/networking-and-keys.md).
