import { describe, expect, it } from "vitest";
import { VirtualFS, createFileTools, norm } from "../src/tools/fs.js";
import type { FSChange } from "../src/tools/fs.js";

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

  it("normalizes . and .. segments", () => {
    expect(norm("a/./b.txt")).toBe("a/b.txt");
    expect(norm("a/../b.txt")).toBe("b.txt");
    expect(norm("../../a.txt")).toBe("a.txt");
    const fs = new VirtualFS();
    fs.write("src/../a.txt", "A");
    expect(fs.read("a.txt")).toBe("A");
  });

  it("tracks dirty paths and drains them once", () => {
    const fs = new VirtualFS({ "seed.txt": "s" });
    fs.write("a.txt", "A");
    expect(fs.drainDirty()).toEqual({ "seed.txt": "s", "a.txt": "A" });
    expect(fs.drainDirty()).toEqual({});
    fs.write("a.txt", "A2");
    expect(fs.drainDirty()).toEqual({ "a.txt": "A2" });
  });

  it("applyExternal updates content without marking dirty", () => {
    const fs = new VirtualFS();
    fs.drainDirty();
    fs.applyExternal("out.txt", "from sandbox");
    expect(fs.read("out.txt")).toBe("from sandbox");
    expect(fs.drainDirty()).toEqual({});
  });

  it("markDirty re-queues failed pushes", () => {
    const fs = new VirtualFS({ "a.txt": "A" });
    const dirty = fs.drainDirty();
    fs.markDirty(Object.keys(dirty));
    expect(fs.drainDirty()).toEqual({ "a.txt": "A" });
  });

  it("emits change events with the right source", () => {
    const fs = new VirtualFS();
    const seen: FSChange[] = [];
    const unsub = fs.onChange((c) => seen.push(c));
    fs.write("a.txt", "A");
    fs.applyExternal("b.txt", "B");
    unsub();
    fs.write("c.txt", "C");
    expect(seen).toEqual([
      { path: "a.txt", content: "A", source: "write" },
      { path: "b.txt", content: "B", source: "external" },
    ]);
  });
});

describe("file tools", () => {
  it("write then read round-trips", async () => {
    const fs = new VirtualFS();
    const t = toolMap(fs);
    await t.write!.execute("1", { path: "x.ts", content: "export const x = 1;" } as never);
    expect(textOf(await t.read!.execute("2", { path: "x.ts" } as never))).toContain("export const x");
  });

  it("edit replaces a unique match", async () => {
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

  it("edit requires a unique match unless replaceAll is set", async () => {
    const fs = new VirtualFS({ "x.ts": "a; a; a;" });
    const t = toolMap(fs);
    await expect(t.edit!.execute("1", { path: "x.ts", old: "a", new: "b" } as never)).rejects.toThrow(
      /3 times/,
    );
    await t.edit!.execute("2", { path: "x.ts", old: "a", new: "b", replaceAll: true } as never);
    expect(fs.read("x.ts")).toBe("b; b; b;");
  });

  it("grep finds matching lines", async () => {
    const fs = new VirtualFS({ "a.ts": "foo\nbar", "b.ts": "baz" });
    const t = toolMap(fs);
    const out = textOf(await t.grep!.execute("1", { pattern: "ba." } as never));
    expect(out).toContain("a.ts:2:bar");
    expect(out).toContain("b.ts:1:baz");
  });

  it("grep reports an invalid regex instead of blowing up", async () => {
    const fs = new VirtualFS({ "a.ts": "x" });
    const t = toolMap(fs);
    await expect(t.grep!.execute("1", { pattern: "(" } as never)).rejects.toThrow(
      /invalid regular expression/,
    );
  });
});
