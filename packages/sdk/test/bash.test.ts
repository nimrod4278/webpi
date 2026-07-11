import { describe, expect, it } from "vitest";
import { createBashTool, buildPushScript, buildPullScript, parsePullOutput } from "../src/tools/bash.js";
import { VirtualFS } from "../src/tools/fs.js";
import { toBase64 } from "../src/base64.js";
import { WepiError } from "../src/errors.js";
import type { ExecResult, Sandbox } from "../src/sandbox/index.js";

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? "").join("");

/** Records exec calls and replays scripted results. */
class MockSandbox implements Sandbox {
  calls: { command: string; cwd?: string; signal?: AbortSignal }[] = [];
  results: (ExecResult | Error)[] = [];

  async exec(command: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ExecResult> {
    this.calls.push({ command, cwd: opts?.cwd, signal: opts?.signal });
    const next = this.results.shift() ?? { stdout: "", stderr: "", code: 0 };
    if (next instanceof Error) throw next;
    return next;
  }
}

describe("push/pull script building & parsing", () => {
  it("push script writes each file base64-encoded under workdir and touches the stamp", () => {
    const script = buildPushScript({ "src/a.ts": "const a = 1;" }, "/workspace");
    expect(script).toContain(toBase64("const a = 1;"));
    expect(script).toContain("'/workspace/src/a.ts'");
    expect(script).toContain("mkdir -p '/workspace/src'");
    expect(script).toContain("touch /tmp/.wepi/stamp");
  });

  it("pull output round-trips file contents, stripping ./ prefixes", () => {
    const stdout = [
      "<<WEPI_F>>./out.txt",
      toBase64("hello from the vm\n"),
      "<<WEPI_E>>",
      "<<WEPI_F>>./sub/b.txt",
      toBase64("nested"),
      "<<WEPI_E>>",
    ].join("\n");
    expect(parsePullOutput(stdout)).toEqual({
      "out.txt": "hello from the vm\n",
      "sub/b.txt": "nested",
    });
  });

  it("pull script survives a missing stamp (exits 0 early)", () => {
    expect(buildPullScript("/workspace")).toContain("|| exit 0");
  });
});

describe("bash tool with workspace sync", () => {
  it("pushes dirty files, runs the command, and pulls changes back", async () => {
    const fs = new VirtualFS({ "a.ts": "console.log(1)" });
    const sandbox = new MockSandbox();
    sandbox.results = [
      { stdout: "", stderr: "", code: 0 }, // push
      { stdout: "ran ok", stderr: "", code: 0 }, // command
      { stdout: `<<WEPI_F>>./out.txt\n${toBase64("built")}\n<<WEPI_E>>`, stderr: "", code: 0 }, // pull
    ];
    const bash = createBashTool(sandbox, { fs });

    const result = await bash.execute("1", { command: "node a.ts > out.txt" } as never);

    expect(sandbox.calls).toHaveLength(3);
    expect(sandbox.calls[0]!.command).toContain(toBase64("console.log(1)")); // push carried the file
    expect(sandbox.calls[1]!.command).toBe("node a.ts > out.txt");
    expect(sandbox.calls[1]!.cwd).toBe("/workspace");
    expect(textOf(result)).toContain("ran ok");
    // The pulled file landed in the workspace, not marked dirty again:
    expect(fs.read("out.txt")).toBe("built");
    expect(fs.drainDirty()).toEqual({});
  });

  it("second call pushes nothing new but still stamps", async () => {
    const fs = new VirtualFS({ "a.ts": "x" });
    const sandbox = new MockSandbox();
    const bash = createBashTool(sandbox, { fs });
    await bash.execute("1", { command: "true" } as never);
    sandbox.calls = [];
    await bash.execute("2", { command: "true" } as never);
    expect(sandbox.calls[0]!.command).not.toContain(toBase64("x"));
    expect(sandbox.calls[0]!.command).toContain("touch /tmp/.wepi/stamp");
  });

  it("re-marks files dirty and rethrows when the push is aborted", async () => {
    const fs = new VirtualFS({ "a.ts": "x" });
    const sandbox = new MockSandbox();
    sandbox.results = [new WepiError("command aborted", "aborted")];
    const bash = createBashTool(sandbox, { fs });

    await expect(bash.execute("1", { command: "true" } as never)).rejects.toMatchObject({
      code: "aborted",
    });
    expect(fs.drainDirty()).toEqual({ "a.ts": "x" }); // not lost — retried next call
  });

  it("reports stderr separately and includes the exit code", async () => {
    const sandbox = new MockSandbox();
    sandbox.results = [{ stdout: "partial", stderr: "boom", code: 2 }];
    const bash = createBashTool(sandbox); // no fs → no sync calls
    const result = await bash.execute("1", { command: "false" } as never);
    const text = textOf(result);
    expect(sandbox.calls).toHaveLength(1);
    expect(text).toContain("partial");
    expect(text).toContain("[stderr]\nboom");
    expect(text).toContain("(exit 2)");
  });

  it("forwards the abort signal to the sandbox", async () => {
    const sandbox = new MockSandbox();
    const bash = createBashTool(sandbox);
    const ctrl = new AbortController();
    await bash.execute("1", { command: "true" } as never, ctrl.signal);
    expect(sandbox.calls[0]!.signal).toBe(ctrl.signal);
  });
});
