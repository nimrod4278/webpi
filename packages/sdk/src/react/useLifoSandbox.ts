/**
 * `useLifoSandbox` — boot lifecycle for the lifo.sh (`@lifo-sh/core`) bash sandbox.
 *
 * Instantiates a `LifoSandbox` once and exposes the same `{ sandbox, status,
 * ready, log }` shape as `useC2wSandbox`, so switching backends is a one-line
 * swap. lifo boots ~instantly (no VM, no image), so there is no `warming` step —
 * status goes `idle → booting → ready`. Pass the returned `sandbox` straight into
 * `usePiChat`/`createChat`.
 */

import { useEffect, useRef, useState } from "react";
import { LifoSandbox, type LifoSandboxOptions } from "../sandbox/lifo.js";
import type { SandboxStatus, UseSandboxResult } from "./sandbox-lifecycle.js";

export type UseLifoSandboxResult = UseSandboxResult<LifoSandbox>;

export function useLifoSandbox(
  opts: LifoSandboxOptions & { enabled?: boolean } = {},
): UseLifoSandboxResult {
  const [sandbox, setSandbox] = useState<LifoSandbox>();
  const [status, setStatus] = useState<SandboxStatus>("idle");
  const [log, setLog] = useState("");

  // Boot exactly once (also survives StrictMode's double-mount).
  const startedRef = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;
    setStatus("booting");

    const sb = new LifoSandbox({
      ...optsRef.current,
      onLog: (line) => {
        setLog(line);
        optsRef.current.onLog?.(line);
      },
    });
    setSandbox(sb);

    sb.ready.then(() => setStatus("ready")).catch(() => setStatus("error"));
    // No teardown: the boot-once pattern means a cleanup here would dispose the
    // sandbox on StrictMode's throwaway first mount. The instance lives for the
    // page's lifetime (call `sandbox.dispose()` yourself if you need to reclaim it).
  }, [enabled]);

  return { sandbox, status, ready: status === "ready", log };
}
