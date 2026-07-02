/** Boots C2wSandbox (no agent, no API key) and runs smoke commands against the
 * image in /public/alpine. Results land in #log and on window.__sandboxTest so
 * the page can be driven headlessly.
 * ?image=/alpine-amd64/&emulator=/out-amd64.wasm.gzip to test an alternate stack. */
import { C2wSandbox } from "wepi/c2w";

const logEl = document.getElementById("log")!;
const state = { phase: "booting", bootMs: 0, results: [] as unknown[], tail: "" };
(window as any).__sandboxTest = state;

const line = (s: string) => (logEl.textContent += s + "\n");

const COMMANDS = ["uname -m", "free -m"];

const t0 = performance.now();
const params = new URLSearchParams(location.search);
const sandbox = new C2wSandbox({
  image: params.get("image") ? location.origin + params.get("image") : undefined,
  emulator: params.get("emulator") ? location.origin + params.get("emulator") : undefined,
  onLog: (l) => console.log("[boot]", l),
  // Rolling tail of raw guest output, for eyeballing long-running experiments.
  onOutput: (chunk) => (state.tail = (state.tail + chunk).slice(-2000)),
  execTimeoutMs: 3_600_000, // experiments run node under emulation; way past the default
});
(window as any).__sandbox = sandbox;

// Rejection-safe ad-hoc runner: window.__run("cmd") -> results in window.__exp.
(window as any).__run = (cmd: string) => {
  (window as any).__exp = null;
  sandbox.exec(cmd).then(
    (r) => ((window as any).__exp = { code: r.code, out: (r.stdout + r.stderr).slice(-1500) }),
    (e) => ((window as any).__exp = { error: String(e) }),
  );
  return "running: " + cmd;
};

line("booting…");
try {
  await sandbox.ready;
  state.bootMs = Math.round(performance.now() - t0);
  state.phase = "running";
  line(`ready in ${state.bootMs}ms`);
  for (const cmd of COMMANDS) {
    const t = performance.now();
    const r = await sandbox.exec(cmd);
    const ms = Math.round(performance.now() - t);
    const entry = { cmd, code: r.code, ms, out: (r.stdout + r.stderr).trim().slice(0, 400) };
    state.results.push(entry);
    line(`\n$ ${cmd}\n[exit ${r.code}, ${ms}ms]\n${entry.out}`);
  }
  state.phase = "done";
  line("\nDONE");
} catch (e) {
  state.phase = "error: " + e;
  line("ERROR: " + e);
}
