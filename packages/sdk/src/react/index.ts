/**
 * `wepi/react` — React bindings for the pi agent in the browser.
 *
 *   import { PiChat } from "wepi/react";
 *   import "wepi/react/PiChat.css";                 // optional default styling
 *   <PiChat apiKey={key} />                          // drop-in, boots c2w bash
 *
 * Or compose your own UI with the hooks:
 *   import { usePiChat, useC2wSandbox } from "wepi/react";
 */

export { PiChat } from "./PiChat.js";
export type { PiChatProps } from "./PiChat.js";
export { usePiChat } from "./usePiChat.js";
export type { UsePiChatResult, TranscriptEntry } from "./usePiChat.js";
export { useC2wSandbox } from "./useC2wSandbox.js";
export type { UseC2wSandboxResult, C2wStatus } from "./useC2wSandbox.js";
