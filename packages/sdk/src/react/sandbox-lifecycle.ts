/**
 * Shared boot-lifecycle types for the sandbox hooks (`useC2wSandbox`,
 * `useLifoSandbox`). Every backend hook returns this identical shape so that
 * swapping one for another in app code is a one-line change and the compiler
 * enforces the parity.
 */

import type { Sandbox } from "../sandbox/index.js";

/** Coarse boot status for a status display. `warming` is only used by backends
 *  that pay a first-command JIT cost (e.g. the c2w VM); instant backends go
 *  straight `booting → ready`. */
export type SandboxStatus = "idle" | "booting" | "warming" | "ready" | "error";

export interface UseSandboxResult<S extends Sandbox = Sandbox> {
  /** The sandbox instance (available as soon as booting starts). */
  sandbox: S | undefined;
  status: SandboxStatus;
  /** True once boot (+ warm-up, where applicable) finished. */
  ready: boolean;
  /** Latest boot/lifecycle log line, for a status display. */
  log: string;
}
