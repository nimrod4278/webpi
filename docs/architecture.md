# Architecture

This page explains how wepi is put together: the agent, the workspace, the
sandbox, the sync protocol, and the seams you can swap.

## The big picture

```
Main thread                                Web Worker
 Agent loop (pi-agent-core, native JS)      container2wasm Alpine VM
  ├─ model calls → fetch → LLM API           └─ /bin/sh on a raw PTY
  ├─ file tools → VirtualFS (in-memory)          ↑ bash commands, file-framed
  └─ bash tool ──sync /workspace──────────────────┘ (base64 in/out, fenced)
       VirtualFS ↔ snapshots ↔ ChatStore (IndexedDB / your backend)
```

Three things are worth internalizing:

1. **The agent runs natively.** `Chat` wraps a pi-agent-core `Agent` — real
   JavaScript, full-speed model streaming. There is no WebAssembly emulation of
   the agent itself.
2. **Only shell execution is sandboxed.** The `bash` tool is the sole thing that
   crosses into the WebAssembly VM. The VM has no network and no host
   filesystem, so prompt-injected shell commands are contained.
3. **File tools and bash share one filesystem** by syncing the in-memory
   workspace into the VM around each command.

## `Chat` — the public object

`Chat` (in `chat.ts`) is the composition root. On construction it:

- creates a `VirtualFS` seeded from `options.files`;
- builds a model + `streamFn` + `getApiKey` via `buildModel` (see
  [Models & providers](guides/models.md));
- assembles the tool set: the file tools, one `bash` tool bound to the sandbox,
  plus any extra `tools` you pass;
- constructs the pi-agent-core `Agent` with a system prompt, model, and tools;
- subscribes to agent events to fan them out to your `subscribe` listeners and
  to persist a snapshot on `agent_end`.

`createChat` wraps `new Chat(...)` and awaits `restore()` so a persisted
snapshot is loaded before you send anything.

## The workspace: `VirtualFS`

The workspace is an in-memory, dirty-tracking, observable filesystem
(`tools/fs.ts`). It is the source of truth for the agent's files. Key traits:

- **Observable.** `fs.onChange(cb)` fires on writes/edits, which is how live
  file-tree UIs stay current.
- **Dirty tracking.** Files changed since the last sandbox push are marked
  dirty, so only changes are pushed into the VM (see below).
- **String contents only** in the POC — binary files are deferred.

`chat.files()` returns a plain `{ path: contents }` snapshot; `chat.fs` exposes
the live object.

## The `Sandbox` seam

The `bash` tool talks to a `Sandbox` — an interface with a **single method**:

```ts
interface Sandbox {
  exec(command: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ExecResult>;
}
interface ExecResult { stdout: string; stderr: string; code: number; }
```

Two implementations ship:

- **`NullSandbox`** (default): `bash` returns exit code 127 with a message that
  the shell is unavailable. File tools still work. This keeps sandbox-less chats
  (file tools only) fully functional with no hosting requirements.
- **`C2wSandbox`** (`wepi/c2w`): a container2wasm Alpine VM in a Web Worker,
  driving `/bin/sh` over a raw PTY with a base64, sentinel-fenced framing
  protocol so terminal echo cannot fake a command boundary. See
  [The bash sandbox](guides/sandbox.md).

Because everything the tool needs is `exec`, you can drop in any backend — a
server-side runner, a WebContainer, a remote VM — and inherit workspace sync for
free.

## Workspace sync

The agent's file tools operate on the in-memory `VirtualFS`; `bash` operates on
`/workspace` inside the VM. wepi keeps them consistent by mirroring around each
shell command, using pure-POSIX `sh` push/pull scripts layered on top of
`Sandbox.exec` alone (`tools/bash.ts`):

1. **Push (before the command):** dirty workspace files are written into
   `/workspace` in the VM.
2. **Run** the agent's command.
3. **Pull (after the command):** files under `/workspace` are read back into the
   `VirtualFS`.

Because sync is plain POSIX over `exec`, **any** `Sandbox` implementation gets it
without extra code. Two limitations are deliberate in the POC:

- **Deletion propagation is deferred** — files deleted inside the VM are not
  removed from the workspace.
- **Binary files are deferred** — string contents only.

## Turn semantics

`chat.send()` returns a `Turn` (`turn.ts`), which implements both
`AsyncIterable<string>` (text deltas) and `PromiseLike<string>` (the full
reply). Its settlement rules are the contract you code against:

- **Success:** resolves with the full assistant text on `agent_end`.
- **Abort:** an aborted turn **resolves** with the partial text; check
  `turn.aborted`. Stopping is not an error.
- **Failure:** a provider error **rejects** with a `WepiError` whose `code`
  distinguishes `auth` / `rate_limit` / `provider` / etc.
- **Concurrency:** a second `send()` while a turn is in flight throws a
  `WepiError` with code `busy`.

See [Error handling](guides/error-handling.md).

## Persistence: the `ChatStore` seam

Persistence is a two-method interface (`store.ts`):

```ts
interface ChatStore {
  load(id: string): Promise<ChatSnapshot | null>;
  save(id: string, snapshot: ChatSnapshot): Promise<void>;
  list?(): Promise<{ id: string; updatedAt: number }[]>;
  delete?(id: string): Promise<void>;
}
```

Snapshots (`{ version, messages, files, updatedAt }`) are saved **once per
completed turn**, never per token, so a network-backed store is cheap. The
default is `IndexedDBStore`; the interface module has no DB imports so a
server-side store never pulls in browser storage code. See
[Persistence](guides/persistence.md).

## Model wiring

`buildModel` (`model.ts`) resolves the provider and model and returns the
`streamFn`/`getApiKey` the agent needs. Cloud providers come from a curated
registry keyed by string id; anything else — another pi-ai provider, an
OpenAI-compatible endpoint, or a **local** WebGPU engine — plugs in through the
same seam by passing a pi-ai `Provider` object. Injected providers are treated
as keyless, so local models need no credentials. See
[Models & providers](guides/models.md) and [Local models](guides/local-models.md).

## The seams, summarized

| Seam | Interface | Default | Swap for |
| --- | --- | --- | --- |
| Execution | `Sandbox.exec` | `NullSandbox` | `C2wSandbox`, server runner, WebContainer |
| Persistence | `ChatStore` | `IndexedDBStore` | your API, Postgres, Supabase |
| Model | pi-ai `Provider` | Anthropic | any cloud id, custom provider, local engine |

Each is intentionally minimal so implementations stay small and testable.
