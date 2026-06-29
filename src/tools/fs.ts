/**
 * Virtual workspace + file tools for the browser agent.
 *
 * The workspace is a plain in-memory map — the page sandbox guarantees the agent
 * can never reach the host filesystem, so this IS the contained sandbox for files.
 * Tools throw on failure (per AgentTool contract).
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export class VirtualFS {
  private files = new Map<string, string>();

  constructor(init: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(init)) this.files.set(norm(p), c);
  }

  read(path: string): string {
    const f = this.files.get(norm(path));
    if (f === undefined) throw new Error(`no such file: ${path}`);
    return f;
  }
  write(path: string, content: string): void {
    this.files.set(norm(path), content);
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
}

function norm(p: string): string {
  return p.replace(/^\.?\/+/, "").trim();
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
    old: Type.String({ description: "Exact text to replace" }),
    new: Type.String({ description: "Replacement text" }),
  });
  const edit: AgentTool<typeof editParams> = {
    name: "edit",
    label: "Edit file",
    description: "Replace the first occurrence of `old` with `new` in a file.",
    parameters: editParams,
    execute: async (_id, { path, old, new: nu }: Static<typeof editParams>) => {
      const cur = fs.read(path);
      if (!cur.includes(old)) throw new Error(`text not found in ${path}`);
      fs.write(path, cur.replace(old, nu));
      return text(`edited ${path}`);
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
      const re = new RegExp(pattern);
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
