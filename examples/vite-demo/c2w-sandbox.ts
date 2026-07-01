/**
 * C2wSandbox — implements wepi's `Sandbox` using a light container2wasm Alpine
 * VM (llmlet-style): a generic --external-bundle emulator + an Alpine OCI image
 * mounted at runtime via imagemounter + the runcontainerjs exec bridge.
 *
 * The agent stays native; this only runs the `bash` tool's commands. We drive an
 * interactive /bin/sh over a RAW-mode PTY and capture output up to a unique
 * sentinel (classic pexpect pattern), so no terminal UI is needed.
 *
 * Globals (loaded via <script> in index.html): RunContainer, openpty, TtyServer,
 * Termios, and the termios flag constants from xterm-pty.
 */

import type { Sandbox, ExecResult } from "wepi";

// xterm-pty + runcontainerjs put these on the global scope.
const g = window as unknown as Record<string, any>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
void encoder;

function rawTermios(slave: any): void {
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
  /** OCI image URL (default: /alpine/ served by the demo). */
  image?: string;
  onLog?: (line: string) => void;
  /** Fail boot if it hasn't completed in this many ms (default 180000). */
  bootTimeoutMs?: number;
}

export class C2wSandbox implements Sandbox {
  readonly ready: Promise<void>;
  private inject!: (s: string) => void;
  private listener: ((chunk: string) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private log: (s: string) => void;

  constructor(opts: C2wSandboxOptions = {}) {
    this.log = opts.onLog ?? (() => {});
    this.ready = this.boot(
      opts.image ?? location.origin + "/alpine/",
      opts.bootTimeoutMs ?? 180_000,
    );
  }

  private async boot(image: string, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const msg = `sandbox boot timed out after ${Math.round(timeoutMs / 1000)}s`;
        this.log("boot ERROR: " + msg);
        reject(new Error(msg));
      }, timeoutMs);
    });
    try {
      await Promise.race([this.bootInner(image), timeout]);
    } catch (e) {
      this.log("boot ERROR: " + e);
      console.error("[sandbox] boot failed", e);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async bootInner(image: string): Promise<void> {
    const origin = location.origin;
    this.log("fetching emulator + mounting image…");
    const info = await g.RunContainer.createContainerWASI(
      origin + "/out.wasm.gzip",
      image,
      origin + "/dist/stack-worker.js",
      origin + "/imagemounter.wasm.gzip",
    );
    this.log("image mounted; starting VM + shell…");

    const { master, slave } = g.openpty();
    rawTermios(slave);
    const term = fakeTerminal((s) => this.listener?.(s));
    master.activate(term);
    this.inject = term.inject;

    const worker = new Worker(origin + "/worker.js");
    worker.postMessage({ type: "init", info, args: ["/bin/sh"] });
    new g.TtyServer(slave).start(worker);

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
      const send = () => this.inject(`export PS1=''; export PS2=''; printf '${marker}:%d\\n' 0\n`);
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

  /** Helper: inject and resolve when `pattern` appears in output. */
  private until(run: (send: (cmd: string, pattern: RegExp) => void) => void): Promise<string> {
    return new Promise<string>((resolve) => {
      let buf = "";
      let pat: RegExp | undefined;
      this.listener = (chunk) => {
        buf += chunk;
        if (pat && pat.test(buf)) {
          this.listener = null;
          resolve(buf);
        }
      };
      run((cmd, pattern) => {
        pat = pattern;
        this.inject(cmd);
      });
    });
  }

  async exec(command: string): Promise<ExecResult> {
    await this.ready;
    // Serialize commands over the single shell.
    const result = this.chain.then(() => this.run(command));
    this.chain = result.catch(() => {});
    return result;
  }

  private run(command: string): Promise<ExecResult> {
    const marker = "WEPI_" + Math.random().toString(36).slice(2);
    const re = new RegExp(marker + ":(-?\\d+)");
    return this.until((send) => {
      // Run the command, then print a sentinel with its exit code.
      send(`{ ${command}\n} ; printf '\\n${marker}:%d\\n' "$?"\n`, re);
    }).then((buf) => {
      const m = buf.match(re);
      const code = m ? parseInt(m[1]!, 10) : -1;
      const stdout = buf.replace(new RegExp("\\n?" + marker + ":-?\\d+\\n?"), "");
      return { stdout, stderr: "", code };
    });
  }
}
