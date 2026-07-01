/**
 * `useC2wSandbox` — boot + warm-up lifecycle for the container2wasm bash sandbox.
 *
 * Instantiates a `C2wSandbox` once, exposes a coarse `status` for the UI, and
 * pays the first-command JIT cost up front with a `uname -a` warm-up (lifted from
 * the old vanilla demo) so the user's first real `bash` runs on a warm VM.
 *
 * The C2wSandbox object exists synchronously; `status` reaches "ready" only after
 * its `ready` promise resolves and the warm-up runs. Pass the returned `sandbox`
 * straight into `usePiChat`/`createChat`.
 */

import { useEffect, useRef, useState } from "react";
import { C2wSandbox, type C2wSandboxOptions } from "../c2w/index.js";

export type C2wStatus = "idle" | "booting" | "warming" | "ready" | "error";

export interface UseC2wSandboxResult {
  /** The sandbox instance (available as soon as booting starts). */
  sandbox: C2wSandbox | undefined;
  status: C2wStatus;
  /** True once boot + warm-up finished. */
  ready: boolean;
  /** Latest boot/lifecycle log line, for a status display. */
  log: string;
}

export function useC2wSandbox(
  opts: C2wSandboxOptions & { enabled?: boolean } = {},
): UseC2wSandboxResult {
  const [sandbox, setSandbox] = useState<C2wSandbox>();
  const [status, setStatus] = useState<C2wStatus>("idle");
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

    const sb = new C2wSandbox({
      ...optsRef.current,
      onLog: (line) => {
        setLog(line);
        optsRef.current.onLog?.(line);
      },
    });
    setSandbox(sb);

    sb.ready
      .then(async () => {
        setStatus("warming");
        try {
          await sb.exec("uname -a"); // prime the VM; best-effort
        } catch {
          /* never block on warm-up */
        }
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
    // C2wSandbox has no teardown in the POC — the worker lives for the page's
    // lifetime, so there is intentionally no cleanup here.
  }, [enabled]);

  return { sandbox, status, ready: status === "ready", log };
}
