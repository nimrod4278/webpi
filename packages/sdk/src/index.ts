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
export type { ChatOptions, SendOptions, ChatMetrics } from "./chat.js";
export { Turn } from "./turn.js";
export type { ToolEvent } from "./turn.js";
export { VirtualFS, createFileTools } from "./tools/fs.js";
export type { FSChange } from "./tools/fs.js";
export { createBashTool } from "./tools/bash.js";
export type { BashToolOptions } from "./tools/bash.js";
export { NullSandbox } from "./sandbox.js";
export type { Sandbox, ExecResult } from "./sandbox.js";
export { buildModel } from "./model.js";
export type { ModelConfig, BuiltModel } from "./model.js";
// Re-exported for consumers injecting a custom/local provider (e.g. wepi/webllm).
export type { Api, Model, Provider } from "@earendil-works/pi-ai";
export { WepiError } from "./errors.js";
export type { WepiErrorCode } from "./errors.js";
export type { ChatStore, ChatSnapshot } from "./store.js";
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
