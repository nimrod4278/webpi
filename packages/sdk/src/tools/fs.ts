/**
 * Virtual workspace + file tools for the browser agent.
 *
 * The workspace is a plain in-memory map — the page sandbox guarantees the agent
 * can never reach the host filesystem, so this IS the contained sandbox for files.
 * Tools throw on failure (per AgentTool contract).
 *
 * The workspace is observable (`onChange`) so UIs can render a live file tree,
 * and tracks dirty paths so the bash tool can mirror only changed files into
 * the exec sandbox (see tools/bash.ts).
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

/** Emitted whenever a file changes, from any source (tool, app, sandbox sync). */
export interface FSChange {
  path: string;
  content: string;
  /** "external" = pulled back from the exec sandbox, not written by the agent. */
  source: "write" | "external";
}

export class VirtualFS {
  private files = new Map<string, string>();
  private dirty = new Set<string>();
  private listeners = new Set<(change: FSChange) => void>();

  constructor(init: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(init)) this.write(p, c);
  }

  read(path: string): string {
    const f = this.files.get(norm(path));
    if (f === undefined) throw new Error(`no such file: ${path}`);
    return f;
  }

  /** Write a file and mark it dirty (to be mirrored into the exec sandbox). */
  write(path: string, content: string): void {
    const p = norm(path);
    this.files.set(p, content);
    this.dirty.add(p);
    this.emit({ path: p, content, source: "write" });
  }

  /**
   * Apply a change that originated in the exec sandbox: updates content and
   * notifies listeners, but does NOT mark the path dirty (it is already in
   * sync with the sandbox).
   */
  applyExternal(path: string, content: string): void {
    const p = norm(path);
    this.files.set(p, content);
    this.dirty.delete(p);
    this.emit({ path: p, content, source: "external" });
  }

  has(path: string): boolean {
    return this.files.has(norm(path));
  }
  list(): string[] {
    return [...this.files.keys()].sort();
  }
  entries(): [string, string][] {
    return [...this.files.entries()];
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  /** Paths written since the last `drainDirty()`, with their current contents. */
  drainDirty(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.dirty) {
      const c = this.files.get(p);
      if (c !== undefined) out[p] = c;
    }
    this.dirty.clear();
    return out;
  }

  /** Re-mark paths dirty (e.g. when a sandbox push failed and must be retried). */
  markDirty(paths: string[]): void {
    for (const p of paths) if (this.files.has(norm(p))) this.dirty.add(norm(p));
  }

  /** Observe file changes. Returns an unsubscribe function. */
  onChange(listener: (change: FSChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: FSChange): void {
    for (const l of this.listeners) l(change);
  }
}

/** Normalize a workspace-relative path: strip leading ./, resolve . and .. segments. */
export function norm(p: string): string {
  const out: string[] = [];
  for (const part of p.trim().replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function text(s: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: s }], details: undefined };
}

/** Build the file tools bound to a VirtualFS. */
export function createFileTools(fs: VirtualFS): AgentTool[] {
  const readParams = Type.Object({ path: Type.String({ description: "Workspace-relative file path" }) });
  const read: AgentTool<typeof readParams> = {
    name: "read",
    label: "Read file",
    description: "Read the contents of a file in the workspace.",
    parameters: readParams,
    execute: async (_id, { path }: Static<typeof readParams>) => text(fs.read(path)),
  };

  const writeParams = Type.Object({
    path: Type.String({ description: "Workspace-relative file path" }),
    content: Type.String({ description: "Full file contents to write" }),
  });
  const write: AgentTool<typeof writeParams> = {
    name: "write",
    label: "Write file",
    description: "Create or overwrite a file in the workspace.",
    parameters: writeParams,
    execute: async (_id, { path, content }: Static<typeof writeParams>) => {
      fs.write(path, content);
      return text(`wrote ${content.length} bytes to ${path}`);
    },
  };

  const editParams = Type.Object({
    path: Type.String({ description: "Workspace-relative file path" }),
    old: Type.String({ description: "Exact text to replace. Must be unique in the file unless replaceAll is set." }),
    new: Type.String({ description: "Replacement text" }),
    replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence instead of requiring a unique match" })),
  });
  const edit: AgentTool<typeof editParams> = {
    name: "edit",
    label: "Edit file",
    description:
      "Replace `old` with `new` in a file. `old` must match exactly once, or pass replaceAll to replace every occurrence.",
    parameters: editParams,
    execute: async (_id, { path, old, new: nu, replaceAll }: Static<typeof editParams>) => {
      const cur = fs.read(path);
      const count = cur.split(old).length - 1;
      if (count === 0) throw new Error(`text not found in ${path}`);
      if (count > 1 && !replaceAll) {
        throw new Error(
          `text appears ${count} times in ${path}; include more surrounding context to make it unique, or set replaceAll`,
        );
      }
      fs.write(path, replaceAll ? cur.split(old).join(nu) : cur.replace(old, nu));
      return text(`edited ${path}${replaceAll && count > 1 ? ` (${count} replacements)` : ""}`);
    },
  };

  const lsParams = Type.Object({});
  const ls: AgentTool<typeof lsParams> = {
    name: "ls",
    label: "List files",
    description: "List all files in the workspace.",
    parameters: lsParams,
    execute: async () => text(fs.list().join("\n") || "(empty workspace)"),
  };

  const grepParams = Type.Object({ pattern: Type.String({ description: "Regular expression" }) });
  const grep: AgentTool<typeof grepParams> = {
    name: "grep",
    label: "Search files",
    description: "Search file contents with a regular expression.",
    parameters: grepParams,
    execute: async (_id, { pattern }: Static<typeof grepParams>) => {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        throw new Error(`invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
      }
      const hits: string[] = [];
      for (const [path, content] of fs.entries()) {
        content.split("\n").forEach((line, i) => {
          if (re.test(line)) hits.push(`${path}:${i + 1}:${line}`);
        });
      }
      return text(hits.join("\n") || "(no matches)");
    },
  };

  return [read, write, edit, ls, grep] as AgentTool[];
}
