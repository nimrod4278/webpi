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
export type { ChatOptions } from "./chat.js";
export { Turn } from "./turn.js";
export { VirtualFS, createFileTools } from "./tools/fs.js";
export { createBashTool } from "./tools/bash.js";
export { NullSandbox } from "./sandbox.js";
export type { Sandbox, ExecResult } from "./sandbox.js";
export { buildModel } from "./model.js";

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
