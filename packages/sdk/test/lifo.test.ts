/**
 * LifoSandbox, exercised against a FAKE `@lifo-sh/core` (no real kernel boot).
 * Proves the adapter's job: mapping wepi's `exec` onto lifo's `commands.run`,
 * normalizing `{ stdout, stderr, exitCode }` → `{ stdout, stderr, code }`,
 * forwarding `cwd`/`signal`, and translating failures into typed `WepiError`s.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { WepiError } from "../src/errors.js";

/** A fake lifo Sandbox: records run() calls and replays scripted results. */
const runCalls: { cmd: string; options?: any }[] = [];
let runImpl: (cmd: string, options?: any) => Promise<any> = async () => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
});
let created = 0;

vi.mock("@lifo-sh/core", () => ({
  Sandbox: {
    async create(_options?: unknown) {
      created++;
      return {
        commands: {
          run: (cmd: string, options?: any) => {
            runCalls.push({ cmd, options });
            return runImpl(cmd, options);
          },
        },
        destroy() {},
      };
    },
  },
}));

// Import after the mock is registered (vi.mock is hoisted, but keep it explicit).
const { LifoSandbox } = await import("../src/sandbox/lifo.js");

beforeEach(() => {
  runCalls.length = 0;
  created = 0;
  runImpl = async () => ({ stdout: "", stderr: "", exitCode: 0 });
});

describe("LifoSandbox", () => {
  it("normalizes exitCode → code and passes stdout/stderr through", async () => {
    runImpl = async () => ({ stdout: "hello world\n", stderr: "", exitCode: 0 });
    const sb = new LifoSandbox();
    const r = await sb.exec("echo hello world");
    expect(r).toEqual({ stdout: "hello world\n", stderr: "", code: 0 });
    expect(runCalls[0].cmd).toBe("echo hello world");
    expect(created).toBe(1);
  });

  it("surfaces a non-zero exit as a numeric code (not a throw)", async () => {
    runImpl = async () => ({ stdout: "", stderr: "nope: not found\n", exitCode: 127 });
    const sb = new LifoSandbox();
    const r = await sb.exec("nope");
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("not found");
  });

  it("forwards cwd and the exec timeout to commands.run", async () => {
    const sb = new LifoSandbox({ execTimeoutMs: 5000 });
    await sb.exec("ls", { cwd: "/workspace" });
    expect(runCalls[0].options.cwd).toBe("/workspace");
    expect(runCalls[0].options.timeout).toBe(5000);
  });

  it("serializes exec calls so shell state stays coherent", async () => {
    const order: string[] = [];
    runImpl = async (cmd) => {
      order.push("start:" + cmd);
      await new Promise((r) => setTimeout(r, cmd === "first" ? 20 : 0));
      order.push("end:" + cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const sb = new LifoSandbox();
    await Promise.all([sb.exec("first"), sb.exec("second")]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("wraps a run() failure in a sandbox WepiError", async () => {
    runImpl = async () => {
      throw new Error("kernel panic");
    };
    const sb = new LifoSandbox();
    await expect(sb.exec("boom")).rejects.toMatchObject({
      name: "WepiError",
      code: "sandbox",
    });
  });

  it("maps a timeout failure to code 'timeout'", async () => {
    runImpl = async () => {
      throw new Error("command timed out");
    };
    const sb = new LifoSandbox();
    await expect(sb.exec("sleep 999")).rejects.toMatchObject({ code: "timeout" });
  });

  it("rejects a pre-aborted signal as 'aborted'", async () => {
    const sb = new LifoSandbox();
    const ac = new AbortController();
    ac.abort();
    await expect(sb.exec("ls", { signal: ac.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it("throws after dispose()", async () => {
    const sb = new LifoSandbox();
    await sb.ready;
    sb.dispose();
    await expect(sb.exec("ls")).rejects.toBeInstanceOf(WepiError);
  });
});
