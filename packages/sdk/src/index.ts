/**
 * wepi — run the pi coding agent natively in the browser.
 *
 *   import { createChat } from "wepi";
 *   const chat = await createChat({ apiKey });           // Claude by default
 *   const reply = await chat.send("Create hello.ts");    // await full reply
 *   for await (const t of chat.send("Add a test")) ...   // or stream it
 *   chat.files();                                        // read the workspace back
 */

export { createChat, Chat } from "./chat.js";
export type { ChatOptions, SendOptions, ChatMetrics, DefaultToolName } from "./chat.js";
// Marker key local engines put on unparseable tool-call arguments (see chat.ts guard).
export { INVALID_TOOL_ARGS } from "./engine/openai.js";
export { Turn } from "./turn.js";
export type { ToolEvent } from "./turn.js";
export { VirtualFS, createFileTools } from "./tools/fs.js";
export type { FSChange } from "./tools/fs.js";
export { createBashTool } from "./tools/bash.js";
export type { BashToolOptions } from "./tools/bash.js";
export { NullSandbox } from "./sandbox/index.js";
export type { Sandbox, ExecResult } from "./sandbox/index.js";
export { buildModel } from "./model.js";
export type { ModelConfig, BuiltModel } from "./model.js";
// Re-exported for consumers injecting a custom/local provider (e.g. wepi/webllm).
export type { Api, Model, Provider } from "@earendil-works/pi-ai";
// Re-exported for consumers defining custom agent tools (ChatOptions.tools).
export { Type } from "@earendil-works/pi-ai";
export type { Static } from "@earendil-works/pi-ai";
export type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
export { WepiError } from "./errors.js";
export type { WepiErrorCode } from "./errors.js";
export type { ChatStore, ChatSnapshot } from "./store/index.js";
export { IndexedDBStore } from "./store/indexeddb.js";

import { createChat, type ChatOptions } from "./chat.js";

/** One-shot convenience: create a chat, ask once, dispose. */
export async function ask(message: string, options: ChatOptions): Promise<string> {
  const chat = await createChat(options);
  try {
    return await chat.send(message);
  } finally {
    chat.dispose();
  }
}
