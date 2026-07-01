/**
 * Sandbox: the pluggable backend for the agent's `bash`/run-code tool.
 *
 * Milestone 2 will implement this with a light container2wasm Alpine image
 * (llmlet-style: agent stays native, c2w is only a small shell sandbox, image
 * fetched at runtime, workspace mounted at /workspace).
 *
 * For the native-agent milestone, `NullSandbox` is wired in so the agent can use
 * its file tools; `bash` simply reports it is unavailable.
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
