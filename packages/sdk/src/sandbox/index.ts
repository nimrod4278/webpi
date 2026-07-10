/**
 * Sandbox: the pluggable backend for the agent's `bash`/run-code tool.
 *
 * `C2wSandbox` (wepi/c2w) implements it with a container2wasm Alpine VM; any
 * other backend (server-side runner, WebContainer, …) just needs `exec`. The
 * bash tool layers workspace sync on top of `exec` alone, so implementations
 * stay this small. `NullSandbox` is the default when no sandbox is wired:
 * file tools work, `bash` reports it is unavailable.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code (0 = success). */
  code: number;
}

export interface Sandbox {
  /** Run a shell command in the sandbox and return its result. */
  exec(command: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ExecResult>;
}

/** Placeholder sandbox: no execution backend configured. */
export class NullSandbox implements Sandbox {
  async exec(): Promise<ExecResult> {
    return {
      stdout: "",
      stderr:
        "bash is not available in this build (no run-code sandbox configured). " +
        "File tools (read/write/edit/ls/grep) work; wire a Sandbox to enable shell commands.",
      code: 127,
    };
  }
}
