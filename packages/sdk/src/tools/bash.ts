/**
 * The `bash` tool — runs shell commands in the pluggable Sandbox.
 *
 * When given a VirtualFS, it keeps the agent's workspace and the sandbox
 * filesystem coherent: before each command, files written since the last sync
 * are pushed into `workdir` (default /workspace) inside the sandbox; after the
 * command, files the command created or modified are pulled back into the
 * VirtualFS. The model sees ONE filesystem — `write` a file, then run it.
 *
 * Sync is implemented in plain POSIX sh over `Sandbox.exec`, so it works with
 * any Sandbox implementation, not just C2wSandbox. File contents travel
 * base64-encoded in both directions (safe for arbitrary text; non-UTF-8 binary
 * output is pulled lossily — the workspace is string-based).
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Sandbox } from "../sandbox/index.js";
import type { VirtualFS } from "./fs.js";
import { toBase64, fromBase64, shellQuote as shq } from "../base64.js";
import { WepiError } from "../errors.js";

export interface BashToolOptions {
  /** Mirror this workspace into the sandbox around each command. */
  fs?: VirtualFS;
  /** Directory inside the sandbox mirroring the workspace (default /workspace). */
  workdir?: string;
  /** Cap on the text returned to the model (default 30000 chars). */
  maxOutputChars?: number;
}

const STAMP = "/tmp/.wepi/stamp";
const FILE_MARK = "<<WEPI_F>>";
const END_MARK = "<<WEPI_E>>";

/**
 * Build the script that materializes `files` under `workdir` and touches the
 * sync stamp. Always touches the stamp (even with no files) so the pull step
 * only sees changes made by the upcoming command.
 */
export function buildPushScript(files: Record<string, string>, workdir: string): string {
  const lines: string[] = [`mkdir -p ${shq(workdir)} /tmp/.wepi`];
  for (const [path, content] of Object.entries(files)) {
    const full = workdir + "/" + path;
    const dir = full.slice(0, full.lastIndexOf("/"));
    lines.push(`mkdir -p ${shq(dir)}`);
    lines.push(`printf '%s' ${shq(toBase64(content))} | base64 -d > ${shq(full)}`);
  }
  lines.push(`touch ${STAMP}`);
  return lines.join("\n");
}

/** Build the script that emits every file under `workdir` newer than the stamp. */
export function buildPullScript(workdir: string): string {
  return [
    `cd ${shq(workdir)} 2>/dev/null || exit 0`,
    `[ -f ${STAMP} ] || exit 0`,
    `find . -type f -newer ${STAMP} | while IFS= read -r f; do`,
    `  printf '%s%s\\n' ${shq(FILE_MARK)} "$f"`,
    `  base64 "$f"`,
    `  printf '%s\\n' ${shq(END_MARK)}`,
    `done`,
  ].join("\n");
}

/** Parse buildPullScript output into { path: contents }. */
export function parsePullOutput(stdout: string): Record<string, string> {
  const files: Record<string, string> = {};
  let path: string | null = null;
  let b64: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(FILE_MARK)) {
      path = line.slice(FILE_MARK.length).replace(/^\.\//, "");
      b64 = [];
    } else if (line === END_MARK) {
      if (path) files[path] = fromBase64(b64.join(""));
      path = null;
    } else if (path !== null) {
      b64.push(line);
    }
  }
  return files;
}

export function createBashTool(sandbox: Sandbox, options: BashToolOptions = {}): AgentTool {
  const { fs, workdir = "/workspace", maxOutputChars = 30_000 } = options;

  const params = Type.Object({
    command: Type.String({ description: "Shell command to run in the sandbox" }),
  });
  const bash: AgentTool<typeof params> = {
    name: "bash",
    label: "Run shell command",
    description:
      "Run a shell command in the sandbox. The workspace is available at " +
      workdir +
      " (the current directory); files created there appear in the workspace.",
    parameters: params,
    execute: async (_id, { command }: Static<typeof params>, signal) => {
      const notes: string[] = [];

      if (fs) {
        const dirty = fs.drainDirty();
        try {
          const push = await sandbox.exec(buildPushScript(dirty, workdir), { cwd: workdir, signal });
          if (push.code !== 0) {
            fs.markDirty(Object.keys(dirty));
            notes.push(`[workspace sync: push failed (exit ${push.code})]`);
          }
        } catch (e) {
          fs.markDirty(Object.keys(dirty));
          throw e;
        }
      }

      const r = await sandbox.exec(command, { cwd: workdir, signal });

      if (fs) {
        try {
          const pull = await sandbox.exec(buildPullScript(workdir), { cwd: workdir, signal });
          if (pull.code === 0) {
            for (const [path, content] of Object.entries(parsePullOutput(pull.stdout))) {
              fs.applyExternal(path, content);
            }
          } else {
            notes.push(`[workspace sync: pull failed (exit ${pull.code})]`);
          }
        } catch (e) {
          // Never mask the command's own result — unless the user aborted.
          if (e instanceof WepiError && e.code === "aborted") throw e;
          notes.push(`[workspace sync: pull failed (${e instanceof Error ? e.message : String(e)})]`);
        }
      }

      const parts: string[] = [];
      if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
      if (r.stderr.trim()) parts.push("[stderr]\n" + r.stderr.trimEnd());
      parts.push(...notes);
      if (r.code !== 0) parts.push(`(exit ${r.code})`);
      let out = parts.join("\n") || "(exit 0)";
      if (out.length > maxOutputChars) {
        out = out.slice(0, maxOutputChars) + "\n…(output truncated)";
      }
      return { content: [{ type: "text", text: out }], details: r };
    },
  };
  return bash as AgentTool;
}
