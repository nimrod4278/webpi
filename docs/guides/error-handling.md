# Error handling

Every error wepi surfaces — turn failures and sandbox problems — is a
`WepiError` with a `code` you can branch on, so you never have to parse error
strings.

## `WepiError`

```ts
import { WepiError } from "@wepi/sdk";
import type { WepiErrorCode } from "@wepi/sdk";

try {
  await chat.send("do the thing");
} catch (err) {
  if (err instanceof WepiError) {
    switch (err.code) {
      case "auth":       return promptForKey();
      case "rate_limit": return backOffAndRetry();
      case "busy":       return; // a turn is already running
      default:           return showError(err.message);
    }
  }
  throw err;
}
```

`WepiError` extends `Error` (so `message` and `cause` work as usual) and adds a
readonly `code`.

## The codes

| Code | Meaning | Typical trigger |
| --- | --- | --- |
| `auth` | Bad or missing credentials. | No key supplied; provider returns 401/403. |
| `rate_limit` | Rate limited / overloaded. | Provider returns 429 or "overloaded". |
| `aborted` | The turn was stopped via `abort()`. | You called `chat.abort()` / `turn.abort()`. |
| `busy` | Another turn is already in flight. | A second `send()` before the first settled. |
| `provider` | Any other provider-reported error. | Model API failure not matching the above. |
| `sandbox` | The sandbox is unusable. | Boot failed, or a command wedged the shell. |
| `timeout` | A sandbox command exceeded its budget. | Command ran past `execTimeoutMs`. |
| `unknown` | Anything else. | Unknown provider/model id, etc. |

Provider error strings are classified for you: 401/403/auth/credential-ish
messages map to `auth`, 429/rate-limit/overloaded/quota map to `rate_limit`, and
everything else maps to `provider`.

## Turn settlement: abort resolves, failure rejects

The single most important rule:

- **Aborting is not an error.** An aborted turn **resolves** with the partial
  text collected so far. Check `turn.aborted` to know it was stopped:

  ```ts
  const turn = chat.send("long task");
  setTimeout(() => turn.abort(), 2000);
  const partial = await turn;      // resolves, does NOT throw
  if (turn.aborted) console.log("stopped early, partial:", partial);
  ```

- **Provider failures reject** with a `WepiError`:

  ```ts
  try {
    await chat.send("...");
  } catch (e) {
    // e is a WepiError with code auth / rate_limit / provider / ...
  }
```

This split means "user hit stop" and "the model call failed" are distinguishable
without inspecting messages.

## The `busy` guard

Only one turn runs per `Chat` at a time. Calling `send()` while a turn is in
flight throws immediately with code `busy`:

```ts
const a = chat.send("first");
try {
  chat.send("second");           // throws WepiError("busy") synchronously
} catch (e) {
  // wait for `a`, or call chat.abort() first
}
```

In React, `usePiChat().send()` handles this for you — it resolves `false`
(instead of throwing) when a send is dropped because the chat is busy, empty, or
not ready.

## Streaming and errors

When you consume a turn as a stream, a failure surfaces as a rejection from the
`for await` loop:

```ts
try {
  for await (const delta of chat.send("...")) render(delta);
} catch (e) {
  // WepiError here too
}
```

An abort simply ends the stream (the loop finishes); inspect `turn.aborted`
afterward if you need to distinguish it from normal completion.

## Persistence errors are separate

Snapshot saves are background and fire-and-forget. They do **not** reject your
turn — route them through `onPersistError` instead (default: `console.warn`). See
[Persistence](persistence.md).

## See also

- [Architecture](../architecture.md#turn-semantics) — the settlement contract.
- [Networking & keys](networking-and-keys.md) — avoiding `auth` errors.
- [API reference](../api-reference.md) — `WepiError`, `WepiErrorCode`, `Turn`.
