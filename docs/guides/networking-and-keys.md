# Networking & API keys

Cloud providers need credentials. wepi gives you three ways to supply them, in
order of production-readiness. Local models ([Local models](local-models.md)) need
none — skip this page if you only run on-device.

## The three options

```ts
// ✅ Production: your proxy injects the key server-side.
createChat({ baseUrl: "/api/llm" });

// Short-lived tokens minted by your backend, resolved per request.
createChat({ getApiKey: () => mintToken() });

// POC only: the provider key lives in the browser.
createChat({ apiKey });
```

At least one of `apiKey`, `getApiKey`, or `baseUrl` is required for a cloud
provider — otherwise `buildModel` throws a `WepiError` with code `auth`. Injected
`Provider` objects (local engines) are exempt: they are keyless.

## `baseUrl` — proxy (recommended)

Route provider requests through your own endpoint. Your server injects the real
key and forwards to the provider. This keeps the key server-side **and** sidesteps
browser CORS entirely.

```ts
createChat({ baseUrl: "/api/llm", model: "claude-sonnet-4-5" });
```

When `baseUrl` is set, `apiKey` may be omitted. The `baseUrl` is applied to the
resolved model, so it works with any curated provider.

## `getApiKey` — short-lived tokens

Resolve a credential per request — for example, a short-lived token your backend
mints. It receives the provider id and may return a string, `undefined`, or a
promise of either:

```ts
createChat({
  provider: "anthropic",
  getApiKey: async (provider) => {
    const res = await fetch(`/api/token?provider=${provider}`);
    return (await res.json()).token;
  },
});
```

This narrows the blast radius of a leaked credential versus shipping a long-lived
key.

## `apiKey` — browser-direct (POC only)

The simplest setup and the least safe: the long-lived provider key is present in
the page, so anyone who can open dev tools can read it. Use it only for local
development and proofs of concept.

```ts
createChat({ apiKey: import.meta.env.VITE_ANTHROPIC_KEY });
```

### CORS with browser-direct calls

Direct browser calls are subject to CORS — the provider must allow browser
access. For Anthropic, that means opting in with the
`anthropic-dangerous-direct-browser-access` header (pi-ai handles this when
calling Anthropic directly). A `baseUrl` proxy avoids the issue altogether by
making the request same-origin.

## Cross-origin isolation is a different thing

Don't confuse CORS (about *who may call the provider*) with **cross-origin
isolation** (COOP/COEP headers, about `SharedArrayBuffer`). The latter is
required only for the **bash sandbox** and **local models**, not for cloud model
calls. See [The bash sandbox](sandbox.md).

## Recommendation

| Environment | Use |
| --- | --- |
| Local dev / demo | `apiKey` |
| Staging with rotating creds | `getApiKey` |
| Production | `baseUrl` proxy |

## See also

- [Models & providers](models.md) — selecting the provider these credentials are for.
- [Error handling](error-handling.md) — the `auth` and `rate_limit` error codes.
