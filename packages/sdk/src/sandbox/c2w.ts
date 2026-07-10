/**
 * C2wSandbox — implements wepi's `Sandbox` using a light container2wasm Alpine
 * VM (llmlet-style): a generic --external-bundle emulator + an Alpine OCI image
 * mounted at runtime via imagemounter + the runcontainerjs exec bridge.
 *
 * The agent stays native; this only runs the `bash` tool's commands. We drive an
 * interactive /bin/sh over a RAW-mode PTY, but each command is FILE-FRAMED: the
 * script is delivered base64-encoded, executed with stdout/stderr redirected to
 * files, and the results read back base64-fenced. That gives clean stream
 * separation and makes parsing immune to tty echo — the fence delimiters are
 * built from a shell variable, so their literal text never appears in the
 * injected input.
 *
 * Shell state (cwd, env vars) persists across `exec` calls — one shell serves
 * the sandbox's lifetime. If a command hangs past its timeout or is aborted,
 * the shell may be wedged (the raw PTY can't deliver SIGINT reliably); the
 * sandbox then marks itself broken and transparently reboots on the next exec.
 *
 * Globals (loaded via <script> in the host app's index.html): RunContainer,
 * openpty, TtyServer, Termios, and the termios flag constants from xterm-pty.
 * They are looked up lazily at boot — importing this module is side-effect free
 * and safe under SSR. The wasm/image assets remain the host app's
 * responsibility; point `assetsBaseUrl` at wherever they are served.
 */

import type { Sandbox, ExecResult } from "./index.js";
import { WepiError } from "../errors.js";
import { toBase64, fromBase64, shellQuote as shq } from "../base64.js";

const decoder = new TextDecoder();

/** The xterm-pty + runcontainerjs script globals we drive. Untyped upstream. */
type C2wGlobals = Record<string, any>;

function getGlobals(): C2wGlobals {
  const g = globalThis as C2wGlobals;
  const missing = ["RunContainer", "openpty", "TtyServer", "Termios"].filter((k) => !g[k]);
  if (missing.length > 0) {
    throw new WepiError(
      `wepi/c2w: missing globals: ${missing.join(", ")}. Load the xterm-pty and ` +
        `runcontainer <script> tags before booting the sandbox (see README).`,
      "sandbox",
    );
  }
  return g;
}

function rawTermios(g: C2wGlobals, slave: any): void {
  const t = slave.ioctl("TCGETS");
  t.iflag &= ~(g.ISTRIP | g.INLCR | g.IGNCR | g.ICRNL | g.IXON);
  t.oflag &= ~g.OPOST;
  t.lflag &= ~(g.ECHO | g.ECHONL | g.ICANON | g.ISIG | g.IEXTEN);
  slave.ioctl("TCSETS", new g.Termios(t.iflag, t.oflag, t.cflag, t.lflag, t.cc));
}

/** A no-UI terminal that master.activate() drives: capture output, inject input. */
function fakeTerminal(onOutput: (s: string) => void) {
  let dataCb: ((s: string) => void) | null = null;
  const term = {
    cols: 120,
    rows: 30,
    write: (buf: Uint8Array, cb?: () => void) => {
      onOutput(typeof buf === "string" ? buf : decoder.decode(buf));
      cb?.();
    },
    onData: (cb: (s: string) => void) => {
      dataCb = cb;
      return { dispose: () => (dataCb = null) };
    },
    onBinary: (_cb: (s: string) => void) => ({ dispose: () => {} }),
    onResize: (_cb: (s: { cols: number; rows: number }) => void) => ({ dispose: () => {} }),
    inject: (s: string) => dataCb?.(s),
  };
  return term;
}

export interface C2wSandboxOptions {
  /**
   * Base URL under which the wasm/image assets are served (default: the page
   * origin). Expected layout: `${assetsBaseUrl}/out.wasm.gzip`,
   * `${assetsBaseUrl}/imagemounter.wasm.gzip`, `${assetsBaseUrl}/worker.js`,
   * `${assetsBaseUrl}/dist/stack-worker.js`, `${assetsBaseUrl}/alpine/`.
   */
  assetsBaseUrl?: string;
  /** OCI image URL (default: `${assetsBaseUrl}/alpine/`). */
  image?: string;
  /** Emulator wasm URL (default: `${assetsBaseUrl}/out.wasm.gzip`). */
  emulator?: string;
  onLog?: (line: string) => void;
  /** Raw guest tty output, streamed as it arrives (debugging aid). */
  onOutput?: (chunk: string) => void;
  /** Fail boot if it hasn't completed in this many ms (default 180000). */
  bootTimeoutMs?: number;
  /** Per-command time budget in ms (default 120000). */
  execTimeoutMs?: number;
}

/** Where the agent's virtual workspace is mirrored inside the VM. */
export const WORKSPACE_DIR = "/workspace";

export class C2wSandbox implements Sandbox {
  ready: Promise<void>;
  private inject!: (s: string) => void;
  private listener: ((chunk: string) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private worker: Worker | undefined;
  private broken = false;
  private disposed = false;
  private readonly log: (s: string) => void;
  private readonly onOutput: ((chunk: string) => void) | null;
  private readonly image: string;
  private readonly emulator: string;
  private readonly stackWorkerUrl: string;
  private readonly imagemounterUrl: string;
  private readonly workerUrl: string;
  private readonly bootTimeoutMs: number;
  private readonly execTimeoutMs: number;

  constructor(opts: C2wSandboxOptions = {}) {
    this.log = opts.onLog ?? (() => {});
    this.onOutput = opts.onOutput ?? null;
    const assets = (opts.assetsBaseUrl ?? location.origin).replace(/\/+$/, "");
    this.image = opts.image ?? assets + "/alpine/";
    this.emulator = opts.emulator ?? assets + "/out.wasm.gzip";
    this.stackWorkerUrl = assets + "/dist/stack-worker.js";
    this.imagemounterUrl = assets + "/imagemounter.wasm.gzip";
    this.workerUrl = assets + "/worker.js";
    this.bootTimeoutMs = opts.bootTimeoutMs ?? 180_000;
    this.execTimeoutMs = opts.execTimeoutMs ?? 120_000;
    this.ready = this.boot();
  }

  private async boot(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const msg = `sandbox boot timed out after ${Math.round(this.bootTimeoutMs / 1000)}s`;
        this.log("boot ERROR: " + msg);
        reject(new WepiError(msg, "timeout"));
      }, this.bootTimeoutMs);
    });
    try {
      await Promise.race([this.bootInner(), timeout]);
    } catch (e) {
      this.log("boot ERROR: " + e);
      console.error("[sandbox] boot failed", e);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async bootInner(): Promise<void> {
    const g = getGlobals();
    this.log("fetching emulator + mounting image…");
    const info = await g.RunContainer.createContainerWASI(
      this.emulator,
      this.image,
      this.stackWorkerUrl,
      this.imagemounterUrl,
    );
    this.log("image mounted; starting VM + shell…");

    const { master, slave } = g.openpty();
    rawTermios(g, slave);
    const term = fakeTerminal((s) => {
      this.onOutput?.(s);
      this.listener?.(s);
    });
    master.activate(term);
    this.inject = term.inject;

    this.worker = new Worker(this.workerUrl);
    this.worker.postMessage({ type: "init", info, args: ["/bin/sh"] });
    new g.TtyServer(slave).start(this.worker);

    // Wait until the shell answers a readiness probe. Stream boot output so we
    // can see progress, and re-send the probe in case the shell wasn't reading
    // stdin yet when first probed.
    await this.probeReady();
    this.log("sandbox ready");
  }

  private probeReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      // The guest tty echoes injected input, so a plain marker would match our OWN command
      // text before the shell ever runs it. Print the marker with a numeric suffix via
      // printf: the echoed input shows "WEPI_READY:%d" (literal), but only actual EXECUTION
      // produces "WEPI_READY:0" — so matching a digit means the shell is truly live.
      const marker = "WEPI_READY";
      const re = new RegExp(marker + ":\\d");
      let buf = "";
      const send = () =>
        this.inject(
          `export PS1=''; export PS2=''; mkdir -p ${WORKSPACE_DIR} /tmp/.wepi; ` +
            `printf '${marker}:%d\\n' 0\n`,
        );
      this.listener = (chunk) => {
        buf += chunk;
        const tail = buf.replace(/[^\x20-\x7e]+/g, " ").trim().slice(-70);
        this.log("boot… " + tail);
        if (re.test(buf)) {
          this.listener = null;
          clearInterval(iv);
          resolve();
        }
      };
      send();
      const iv = setInterval(() => (this.listener ? send() : clearInterval(iv)), 3000);
    });
  }

  /**
   * Run a shell command. Commands are serialized over the single shell; shell
   * state (cwd, env) persists between calls. `opts.cwd` defaults to /workspace.
   */
  async exec(command: string, opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<ExecResult> {
    if (this.disposed) throw new WepiError("sandbox has been disposed", "sandbox");
    opts.signal?.throwIfAborted();
    const result = this.chain.then(() => this.run(command, opts));
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Tear down the VM worker and reboot. Called automatically after a wedge. */
  async reset(): Promise<void> {
    if (this.disposed) throw new WepiError("sandbox has been disposed", "sandbox");
    this.log("resetting sandbox (rebooting VM)…");
    this.worker?.terminate();
    this.worker = undefined;
    this.listener = null;
    this.broken = false;
    this.chain = Promise.resolve();
    this.ready = this.boot();
    await this.ready;
  }

  /** Terminate the VM worker for good. */
  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
    this.listener = null;
  }

  private async run(
    command: string,
    opts: { cwd?: string; signal?: AbortSignal },
  ): Promise<ExecResult> {
    if (this.broken) await this.reset();
    await this.ready;
    opts.signal?.throwIfAborted();

    const cwd = opts.cwd ?? WORKSPACE_DIR;
    const marker = "WEPI_" + Math.random().toString(36).slice(2);
    const doneRe = new RegExp(marker + "C:(-?\\d+)");

    // File-framed execution. The fence delimiters (`${marker}O<` etc.) are
    // produced by expanding "$M" at run time — the injected text never contains
    // them literally, so tty echo of our own input can't fake a match.
    const b64 = toBase64(command);
    const lines: string[] = ["rm -f /tmp/.wepi/cmd.b64"];
    for (let i = 0; i < b64.length; i += 4096) {
      lines.push(`printf '%s' '${b64.slice(i, i + 4096)}' >> /tmp/.wepi/cmd.b64`);
    }
    lines.push(
      `M=${marker}`,
      `base64 -d /tmp/.wepi/cmd.b64 > /tmp/.wepi/cmd.sh`,
      `cd ${shq(cwd)} 2>/tmp/.wepi/err; sh /tmp/.wepi/cmd.sh >/tmp/.wepi/out 2>>/tmp/.wepi/err`,
      `WEPI_RC=$?`,
      `printf '%sO<' "$M"; base64 /tmp/.wepi/out; printf '>%sE<' "$M"; base64 /tmp/.wepi/err; printf '>%sC:%d\\n' "$M" "$WEPI_RC"`,
      "",
    );

    let buf = "";
    const output = new Promise<string>((resolve) => {
      this.listener = (chunk) => {
        buf += chunk;
        if (doneRe.test(buf)) {
          this.listener = null;
          resolve(buf);
        }
      };
      // Truncate err file fresh per run (cd appends to it).
      this.inject(`: > /tmp/.wepi/err\n` + lines.join("\n"));
    });

    const raced = await this.race(output, opts.signal);
    if (raced.kind !== "ok") {
      // The command may still be running and the raw PTY can't deliver SIGINT
      // reliably — try a best-effort interrupt, then verify the shell answers.
      this.listener = null;
      const recovered = await this.tryRecover();
      if (!recovered) {
        this.broken = true;
        this.log(
          raced.kind === "timeout"
            ? "command timed out; shell wedged — will reboot on next exec"
            : "command aborted; shell wedged — will reboot on next exec",
        );
      }
      if (raced.kind === "timeout") {
        throw new WepiError(
          `command timed out after ${Math.round(this.execTimeoutMs / 1000)}s`,
          "timeout",
        );
      }
      throw new WepiError("command aborted", "aborted");
    }

    return this.parse(raced.value, marker);
  }

  private race(
    output: Promise<string>,
    signal?: AbortSignal,
  ): Promise<{ kind: "ok"; value: string } | { kind: "timeout" } | { kind: "aborted" }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ kind: "timeout" }), this.execTimeoutMs);
      const onAbort = () => finish({ kind: "aborted" });
      const finish = (r: { kind: "ok"; value: string } | { kind: "timeout" } | { kind: "aborted" }) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void output.then((value) => finish({ kind: "ok", value }));
    });
  }

  /** After a wedge: inject ^C and probe; true if the shell answers within 4s. */
  private tryRecover(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const marker = "WEPI_RCVR" + Math.random().toString(36).slice(2);
      const re = new RegExp(marker + ":\\d");
      let buf = "";
      const timer = setTimeout(() => {
        this.listener = null;
        resolve(false);
      }, 4000);
      this.listener = (chunk) => {
        buf += chunk;
        if (re.test(buf)) {
          clearTimeout(timer);
          this.listener = null;
          resolve(true);
        }
      };
      this.inject(`\x03\nprintf '${marker}:%d\\n' 0\n`);
    });
  }

  private parse(buf: string, marker: string): ExecResult {
    const seg = (re: RegExp) => {
      const m = buf.match(re);
      return m ? fromBase64(m[1]!) : "";
    };
    const stdout = seg(new RegExp(marker + "O<([^>]*)>"));
    const stderr = seg(new RegExp(marker + "E<([^>]*)>"));
    const codeMatch = buf.match(new RegExp(marker + "C:(-?\\d+)"));
    const code = codeMatch ? parseInt(codeMatch[1]!, 10) : -1;
    return { stdout, stderr, code };
  }
}
