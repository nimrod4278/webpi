/**
 * `usePiChat` — React binding over the headless `Chat`.
 *
 * Owns a `Chat` instance (created once an `apiKey` is available, disposed on
 * unmount) and turns its streaming `Turn` + `ToolEvent`s into React state: a
 * `transcript` of user/assistant entries that update live as text streams in.
 *
 * This is the exact behavior of the old vanilla demo's send-loop, lifted into a
 * hook so any UI can consume it. `PiChat` is one such UI built on top.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createChat, type Chat, type ChatOptions } from "../chat.js";
import type { ToolEvent } from "../turn.js";

/** One line in the conversation, as rendered by a UI. */
export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** True while the assistant reply is still streaming. */
  streaming: boolean;
  /** Tool calls observed during this (assistant) turn, in order. */
  tools: ToolEvent[];
}

export interface UsePiChatResult {
  /** The underlying Chat, once created (i.e. once `apiKey` is set). */
  chat: Chat | undefined;
  /** True when the Chat is ready to receive messages. */
  ready: boolean;
  /** True while a turn is in flight (only one turn runs at a time). */
  busy: boolean;
  /** The last error thrown by a turn, if any. */
  error: unknown;
  /** User + assistant entries, updated live as text streams. */
  transcript: TranscriptEntry[];
  /** Send a message and stream the reply into the transcript. No-op if busy/empty. */
  send: (text: string) => Promise<void>;
  /** Abort the in-flight turn. */
  abort: () => void;
  /** Read the agent's virtual workspace back out. */
  files: () => Record<string, string>;
}

/**
 * `options` may change every render; the Chat is only (re)created when a field
 * that defines the agent changes (apiKey/model/provider/systemPrompt/sandbox).
 * `files`/`tools` are read from the latest options at creation time.
 */
export function usePiChat(options: ChatOptions): UsePiChatResult {
  const [chat, setChat] = useState<Chat | undefined>();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const chatRef = useRef<Chat | undefined>(undefined);
  const busyRef = useRef(false);
  const idRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const nextId = () => `m${idRef.current++}`;

  // Create (and re-create) the Chat when the agent-defining options change.
  useEffect(() => {
    if (!options.apiKey) return;
    let disposed = false;
    let created: Chat | undefined;
    void (async () => {
      const c = await createChat(optionsRef.current);
      if (disposed) {
        c.dispose();
        return;
      }
      created = c;
      chatRef.current = c;
      setChat(c);
    })();
    return () => {
      disposed = true;
      created?.dispose();
      if (chatRef.current === created) chatRef.current = undefined;
      setChat(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    options.apiKey,
    options.model,
    options.provider,
    options.systemPrompt,
    options.sandbox,
  ]);

  const send = useCallback(async (text: string) => {
    const c = chatRef.current;
    const trimmed = text.trim();
    if (!c || busyRef.current || !trimmed) return;

    busyRef.current = true;
    setBusy(true);
    setError(undefined);

    const asstId = nextId();
    setTranscript((t) => [
      ...t,
      { id: nextId(), role: "user", text: trimmed, streaming: false, tools: [] },
      { id: asstId, role: "assistant", text: "", streaming: true, tools: [] },
    ]);

    const patch = (fn: (e: TranscriptEntry) => TranscriptEntry) =>
      setTranscript((t) => t.map((e) => (e.id === asstId ? fn(e) : e)));

    try {
      const turn = c.send(trimmed, {
        onTool: (ev: ToolEvent) => patch((e) => ({ ...e, tools: [...e.tools, ev] })),
      });
      for await (const delta of turn) {
        patch((e) => ({ ...e, text: e.text + delta }));
      }
      patch((e) => ({ ...e, streaming: false }));
    } catch (err) {
      setError(err);
      patch((e) => ({ ...e, streaming: false, text: `${e.text}\n[error] ${String(err)}` }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const abort = useCallback(() => chatRef.current?.abort(), []);
  const files = useCallback(() => chatRef.current?.files() ?? {}, []);

  return { chat, ready: !!chat, busy, error, transcript, send, abort, files };
}
