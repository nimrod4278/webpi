import { describe, expect, it } from "vitest";
import { VirtualFS, createFileTools } from "../src/tools/fs.js";

function toolMap(fs: VirtualFS) {
  return Object.fromEntries(createFileTools(fs).map((t) => [t.name, t]));
}
const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? "").join("");

describe("VirtualFS", () => {
  it("writes, reads, and snapshots; normalizes leading ./ and /", () => {
    const fs = new VirtualFS({ "a.txt": "A" });
    fs.write("./b.txt", "B");
    fs.write("/c.txt", "C");
    expect(fs.read("a.txt")).toBe("A");
    expect(fs.read("b.txt")).toBe("B");
    expect(fs.snapshot()).toEqual({ "a.txt": "A", "b.txt": "B", "c.txt": "C" });
  });
  it("throws on missing file", () => {
    expect(() => new VirtualFS().read("nope")).toThrow();
  });
});

describe("file tools", () => {
  it("write then read round-trips", async () => {
    const fs = new VirtualFS();
    const t = toolMap(fs);
    await t.write!.execute("1", { path: "x.ts", content: "export const x = 1;" } as never);
    expect(textOf(await t.read!.execute("2", { path: "x.ts" } as never))).toContain("export const x");
  });

  it("edit replaces text", async () => {
    const fs = new VirtualFS({ "x.ts": "const x = 1;" });
    const t = toolMap(fs);
    await t.edit!.execute("1", { path: "x.ts", old: "1", new: "2" } as never);
    expect(fs.read("x.ts")).toBe("const x = 2;");
  });

  it("edit throws when text not found", async () => {
    const fs = new VirtualFS({ "x.ts": "const x = 1;" });
    const t = toolMap(fs);
    await expect(t.edit!.execute("1", { path: "x.ts", old: "zzz", new: "2" } as never)).rejects.toThrow();
  });

  it("grep finds matching lines", async () => {
    const fs = new VirtualFS({ "a.ts": "foo\nbar", "b.ts": "baz" });
    const t = toolMap(fs);
    const out = textOf(await t.grep!.execute("1", { pattern: "ba." } as never));
    expect(out).toContain("a.ts:2:bar");
    expect(out).toContain("b.ts:1:baz");
  });
});
