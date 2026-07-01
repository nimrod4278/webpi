/**
 * `wepi/c2w` — the container2wasm bash sandbox for the pi agent's `bash` tool.
 *
 *   import { C2wSandbox } from "wepi/c2w";
 *   const sandbox = new C2wSandbox({ onLog: console.debug });
 *   const chat = await createChat({ apiKey, sandbox });
 *
 * Requires a cross-origin-isolated page and the xterm-pty + runcontainerjs
 * globals + wasm/image assets served by the host app (see README).
 */

export { C2wSandbox } from "./sandbox.js";
export type { C2wSandboxOptions } from "./sandbox.js";
