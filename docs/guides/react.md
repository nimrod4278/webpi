# React bindings (`wepi/react`)

`wepi/react` gives you a drop-in chat component and the hooks it's built from.
`react` and `react-dom` are **peer dependencies** (>=18).

```bash
pnpm add wepi react react-dom
```

## `<PiChat>` — drop-in component

The fastest path. It boots the c2w bash sandbox for you, so pi can run shell
commands out of the box:

```tsx
import { PiChat } from "wepi/react";
import "wepi/react/PiChat.css"; // optional default styling

<PiChat
  apiKey={key}
  files={{ "README.md": "# my project\n" }}
  persist="proj-1"
/>
```

`PiChatProps` extends the same option surface as `createChat` (apiKey, baseUrl,
getApiKey, model, provider, systemPrompt, files, persist, …), so everything in
[Models](models.md), [Persistence](persistence.md), and
[Networking & keys](networking-and-keys.md) applies here too.

> Because `<PiChat>` boots the sandbox, your page must be cross-origin isolated
> and serve the sandbox runtime assets. See [The bash sandbox](sandbox.md).

## Compose your own UI with hooks

Same agent, your markup. Two hooks: one for the sandbox lifecycle, one for the
chat.

```tsx
import { usePiChat, useC2wSandbox } from "wepi/react";

function MyChat({ apiKey }: { apiKey: string }) {
  const c2w = useC2wSandbox();               // boots + warms the bash sandbox
  const pi = usePiChat({
    apiKey,
    sandbox: c2w.sandbox,
    enabled: !!c2w.sandbox,                  // hold off until the sandbox exists
  });

  return (
    <div>
      {pi.transcript.map((entry) => (
        <div key={entry.id} data-role={entry.role}>
          {entry.text}
          {entry.streaming && <span className="cursor" />}
        </div>
      ))}
      <button disabled={pi.busy} onClick={() => pi.send(input)}>Send</button>
    </div>
  );
}
```

### `usePiChat(options)`

Owns a `Chat` instance — created once credentials are available (and `enabled`
isn't false), disposed on unmount — and turns its streaming turns into React
state.

**Options:** everything in `ChatOptions`, plus:

- `enabled?: boolean` — set false to defer `Chat` creation (e.g. while the
  sandbox is still booting).

**Returns (`UsePiChatResult`):**

| Field | Type | Meaning |
| --- | --- | --- |
| `chat` | `Chat \| undefined` | The underlying `Chat`, once created. |
| `ready` | `boolean` | True when it can receive messages. |
| `busy` | `boolean` | True while a turn is in flight. |
| `error` | `unknown` | The last error thrown by a turn. |
| `transcript` | `TranscriptEntry[]` | User + assistant entries, updated live as text streams. |
| `send` | `(text: string) => Promise<boolean>` | Send; resolves `false` if dropped (busy, empty, not ready). |
| `abort` | `() => void` | Abort the in-flight turn. |
| `files` | `() => Record<string, string>` | Read the workspace back. |

Each `TranscriptEntry` is `{ id, role: "user" | "assistant", text, streaming,
tools }`, where `tools` is the ordered `ToolEvent`s observed during an assistant
turn — enough to render "running `bash`…" inline.

> **Re-creation gotcha.** When an agent-defining option changes
> (apiKey/baseUrl/model/provider/systemPrompt/sandbox), the `Chat` is re-created
> and its message history starts fresh; the on-screen `transcript` is kept for
> display only. Use `persist` to carry real conversation state across reloads and
> re-creations. `files`/`tools`/`persist` are read from the latest options at
> creation time.

### `useC2wSandbox(opts?)`

Boots a `C2wSandbox` once (surviving StrictMode's double-mount), warms it with a
`uname -a` so the user's first real command runs on a warm VM, and reports a
coarse status.

**Returns (`UseC2wSandboxResult`):**

| Field | Type | Meaning |
| --- | --- | --- |
| `sandbox` | `C2wSandbox \| undefined` | Available as soon as booting starts. |
| `status` | `C2wStatus` | `"idle" \| "booting" \| "warming" \| "ready" \| "error"`. |
| `ready` | `boolean` | True once boot + warm-up finished. |
| `log` | `string` | Latest lifecycle log line, for a status display. |

Pass `{ enabled: false }` to defer booting, plus any `C2wSandboxOptions` (e.g.
`onLog`, `assetsBaseUrl`). The sandbox has no teardown in the POC — the worker
lives for the page's lifetime.

## Wiring pattern

The two hooks compose cleanly: gate the chat on the sandbox so pi isn't created
until `bash` is available.

```tsx
const c2w = useC2wSandbox();
const pi  = usePiChat({ apiKey, sandbox: c2w.sandbox, enabled: c2w.ready });
```

For file-only chats (no shell), skip `useC2wSandbox` entirely and drop the
cross-origin-isolation requirement.

## See also

- [The bash sandbox](sandbox.md) — hosting requirements the component needs.
- [Persistence](persistence.md) — carrying state across re-creations.
- [API reference](../api-reference.md) — full `wepi/react` type list.
