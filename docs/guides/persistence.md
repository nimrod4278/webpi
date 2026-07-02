# Persistence

wepi can snapshot a conversation and its workspace so the chat resumes on reload.
Persistence is opt-in via the `persist` option and pluggable via the `ChatStore`
interface.

## Resume on reload (IndexedDB)

Give the chat a stable id. A string id uses the built-in `IndexedDBStore`:

```ts
const chat = await createChat({ apiKey, persist: "project-42" });
```

`createChat` restores the snapshot for that id (if any) **before** returning, so
the transcript and workspace are already populated when you first send. A
snapshot is saved automatically after every completed turn.

## What's in a snapshot

```ts
interface ChatSnapshot {
  version: 1;                          // schema version, for migrations
  messages: AgentMessage[];            // full conversation transcript
  files: Record<string, string>;       // workspace contents by relative path
  updatedAt: number;                   // write timestamp (ms)
}
```

Snapshots are saved **once per completed turn** (on the agent's `agent_end`
event), never per text delta — so even a network round-trip per save is cheap.

## Bring your own store

To persist anywhere else — your API, Postgres, Supabase — implement the
two-method `ChatStore` interface and pass `{ id, store }`:

```ts
import type { ChatStore, ChatSnapshot } from "wepi";

class ApiStore implements ChatStore {
  async load(id: string): Promise<ChatSnapshot | null> {
    const res = await fetch(`/api/chats/${id}`);
    return res.ok ? res.json() : null;
  }
  async save(id: string, snap: ChatSnapshot): Promise<void> {
    await fetch(`/api/chats/${id}`, { method: "PUT", body: JSON.stringify(snap) });
  }
}

const chat = await createChat({
  baseUrl: "/api/llm",
  persist: { id: "project-42", store: new ApiStore() },
});
```

The `store.ts` module has **no database imports**, so a server-side store
implementation never pulls in browser storage code.

### Optional methods

```ts
interface ChatStore {
  load(id: string): Promise<ChatSnapshot | null>;
  save(id: string, snapshot: ChatSnapshot): Promise<void>;
  list?(): Promise<{ id: string; updatedAt: number }[]>; // for a session picker
  delete?(id: string): Promise<void>;                     // to remove a chat
}
```

`list` and `delete` are optional — implement them if your UI needs a session
picker or a delete action.

## Optimistic concurrency

`updatedAt` is a millisecond timestamp on every snapshot. A remote store can use
it to reject a save older than what it already holds — protecting against two
tabs (or two devices) racing on the same chat id:

```ts
async save(id: string, snap: ChatSnapshot) {
  const current = await db.get(id);
  if (current && current.updatedAt >= snap.updatedAt) return; // stale write, drop it
  await db.put(id, snap);
}
```

## Handling save failures

Background saves are fire-and-forget. Supply `onPersistError` to observe
failures (the default logs a warning):

```ts
await createChat({
  apiKey,
  persist: "project-42",
  onPersistError: (err) => reportToSentry(err),
});
```

## Flushing on teardown

`chat.dispose()` aborts any in-flight turn and flushes a final snapshot, so call
it when unmounting to capture the latest state:

```ts
chat.dispose();
```

## Persistence and the React hook

`usePiChat` re-creates the underlying `Chat` when an agent-defining option
changes (apiKey/baseUrl/model/provider/systemPrompt/sandbox), which resets the
agent's message history. Use `persist` to carry real conversation state across
those re-creations and across reloads — the on-screen transcript alone is display
state, not the source of truth. See [React bindings](react.md).

## See also

- [Architecture](../architecture.md) — where snapshots fit in the event flow.
- [API reference](../api-reference.md) — `ChatStore`, `ChatSnapshot`, `IndexedDBStore`.
