/**
 * LifoSandbox — implements wepi's `Sandbox` using lifo.sh (`@lifo-sh/core`), a
 * Linux-like OS reimplemented in pure TypeScript that runs natively in the
 * browser (and Node): a virtual filesystem, a bash-like shell, and 60+ Unix
 * commands, all client-side.
 *
 * Compared to `C2wSandbox` (a real Alpine riscv64 VM via container2wasm) this is
 * far lighter to host — no cross-origin isolation (COOP/COEP), no global
 * `<script>` tags, and no ~45MB image to fetch. The trade-off is that lifo runs
 * its *own* reimplemented commands rather than a real Alpine userland, so some
 * commands differ or are absent. It's the right pick for pure-shell / file
 * workflows where you want zero infrastructure.
 *
 * The agent stays native; this only runs the `bash` tool's commands. `@lifo-sh/core`
 * already exposes exactly the shape we need — `commands.run(cmd) => { stdout,
 * stderr, exitCode }` — so `exec` is a thin adapter over it. Workspace file-sync
 * is layered on top of `exec` by the bash tool, so it works here for free.
 *
 * Shell state (cwd, env vars) persists across `exec` calls — one lifo Sandbox
 * serves this instance's lifetime. `exec` calls are serialized so a `cd` in one
 * command is observed by the next, matching `C2wSandbox`'s stateful semantics.
 *
 * The module import is side-effect free and SSR-safe: `@lifo-sh/core` is loaded
 * lazily on first boot via dynamic `import()`, so importing this file never
 * touches browser globals.
 */

import type { Sandbox, ExecResult } from "./index.js";
import { WepiError } from "../errors.js";

/** The subset of `@lifo-sh/core`'s Sandbox we drive. Kept structural so we don't
 *  need a hard type dependency on the optional peer package. */
interface LifoCore {
  commands: {
    run(
      cmd: string,
      options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; timeout?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  destroy(): void;
}

export interface LifoSandboxOptions {
  /** Persist the virtual filesystem to IndexedDB across reloads (default: false). */
  persist?: boolean;
  /** Extra environment variables for the shell. */
  env?: Record<string, string>;
  /** Initial working directory (lifo default: /home/user). */
  cwd?: string;
  /** Pre-populate files into the VFS at boot: path → content. */
  files?: Record<string, string | Uint8Array>;
  /** Per-command time budget in ms (default: 120_000). */
  execTimeoutMs?: number;
  /** Latest lifecycle log line, for a status display. */
  onLog?: (line: string) => void;
}

export class LifoSandbox implements Sandbox {
  /** Resolves once the lifo Sandbox has booted. Pass the sandbox to a chat only
   *  after (or gate on) this — though `exec` also awaits it internally. */
  ready: Promise<void>;

  private core: LifoCore | undefined;
  private readonly opts: LifoSandboxOptions;
  private readonly log: (line: string) => void;
  private readonly execTimeoutMs: number;
  /** Serializes exec calls so persistent shell state (cwd/env) stays coherent. */
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(opts: LifoSandboxOptions = {}) {
    this.opts = opts;
    this.log = opts.onLog ?? (() => {});
    this.execTimeoutMs = opts.execTimeoutMs ?? 120_000;
    this.ready = this.boot();
  }

  private async boot(): Promise<void> {
    try {
      this.log("loading @lifo-sh/core…");
      // Dynamic import keeps the module side-effect free and the dep optional.
      const mod = (await import("@lifo-sh/core")) as {
        Sandbox: { create(options?: unknown): Promise<LifoCore> };
      };
      this.log("booting lifo sandbox…");
      this.core = await mod.Sandbox.create({
        persist: this.opts.persist,
        env: this.opts.env,
        cwd: this.opts.cwd,
        files: this.opts.files,
      });
      this.log("sandbox ready");
    } catch (e) {
      const msg = `lifo sandbox boot failed: ${e instanceof Error ? e.message : String(e)}`;
      this.log("boot ERROR: " + msg);
      throw new WepiError(
        msg +
          ". Install the optional peer dependency: `npm i @lifo-sh/core`.",
        "sandbox",
        { cause: e },
      );
    }
  }

  async exec(command: string, opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<ExecResult> {
    if (this.disposed) throw new WepiError("sandbox has been disposed", "sandbox");
    // Chain onto the previous exec so shell state stays coherent; never let one
    // failure poison the chain.
    const result = this.chain.then(() => this.run(command, opts));
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async run(command: string, opts: { cwd?: string; signal?: AbortSignal }): Promise<ExecResult> {
    await this.ready;
    if (!this.core) throw new WepiError("lifo sandbox is not ready", "sandbox");
    if (opts.signal?.aborted) throw new WepiError("command aborted", "aborted");
    try {
      const { stdout, stderr, exitCode } = await this.core.commands.run(command, {
        cwd: opts.cwd,
        signal: opts.signal,
        timeout: this.execTimeoutMs,
      });
      return { stdout, stderr, code: exitCode };
    } catch (e) {
      if (opts.signal?.aborted) throw new WepiError("command aborted", "aborted", { cause: e });
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout|timed out/i.test(msg)) {
        throw new WepiError(`command timed out after ${Math.round(this.execTimeoutMs / 1000)}s`, "timeout", { cause: e });
      }
      throw new WepiError(`lifo exec failed: ${msg}`, "sandbox", { cause: e });
    }
  }

  /** Release the underlying lifo Sandbox. Optional — safe to leave for GC. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.core?.destroy();
    } catch {
      /* best-effort */
    }
    this.core = undefined;
  }
}
