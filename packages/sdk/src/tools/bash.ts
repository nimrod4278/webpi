/** The `bash` tool — runs shell commands in the pluggable Sandbox. */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Sandbox } from "../sandbox.js";

export function createBashTool(sandbox: Sandbox): AgentTool {
  const params = Type.Object({
    command: Type.String({ description: "Shell command to run in the sandbox" }),
  });
  const bash: AgentTool<typeof params> = {
    name: "bash",
    label: "Run shell command",
    description: "Run a shell command in the sandbox and return its combined output.",
    parameters: params,
    execute: async (_id, { command }: Static<typeof params>, signal) => {
      const r = await sandbox.exec(command, { signal });
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: out || `(exit ${r.code})` }], details: r };
    },
  };
  return bash as AgentTool;
}
