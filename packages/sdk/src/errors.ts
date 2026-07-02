/**
 * Typed errors so apps can branch on failure kind instead of parsing strings.
 * Every error surfaced by wepi (turn failures, sandbox problems) is a WepiError.
 */

export type WepiErrorCode =
  /** Provider rejected the credentials (bad/missing API key). */
  | "auth"
  /** Provider rate limit / overloaded. */
  | "rate_limit"
  /** The turn was aborted via `abort()`. */
  | "aborted"
  /** Another turn is already in flight on this Chat. */
  | "busy"
  /** Any other provider-reported error. */
  | "provider"
  /** The sandbox is unusable (boot failed, or a command wedged the shell). */
  | "sandbox"
  /** A sandbox command exceeded its time budget. */
  | "timeout"
  | "unknown";

export class WepiError extends Error {
  readonly code: WepiErrorCode;

  constructor(message: string, code: WepiErrorCode = "unknown", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WepiError";
    this.code = code;
  }
}

/** Map a provider error string to a WepiErrorCode. */
export function classifyProviderError(message: string): WepiErrorCode {
  if (/\b401\b|\b403\b|auth|api.?key|credential|unauthorized/i.test(message)) return "auth";
  if (/\b429\b|rate.?limit|overloaded|quota/i.test(message)) return "rate_limit";
  return "provider";
}
