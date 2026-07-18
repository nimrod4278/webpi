/**
 * `usePiChat` — React binding over the headless `Chat`.
 *
 * Owns a `Chat` instance (created once credentials are available and
 * `enabled` isn't false, disposed on unmount) and turns its streaming `Turn`
 * + `ToolEvent`s into React state: a `transcript` of user/assistant entries
 * that update live as text streams in.
 *
 * Note: when an agent-defining option changes (apiKey/baseUrl/model/provider/
 * systemPrompt/sandbox), the Chat is re-created and its message history starts
 * fresh; the on-screen transcript is kept for display. Use `persist` to carry
 * real conversation state across reloads and re-creations.
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

export interface UsePiChatOptions extends ChatOptions {
  /** Set false to defer Chat creation (e.g. while a sandbox is still booting). */
  enabled?: boolean;
}

export interface UsePiChatResult {
  /** The underlying Chat, once created. */
  chat: Chat | undefined;
  /** True when the Chat is ready to receive messages. */
  ready: boolean;
  /** True while a turn is in flight (only one turn runs at a time). */
  busy: boolean;
  /** The last error thrown by a turn, if any. */
  error: unknown;
  /** User + assistant entries, updated live as text streams. */
  transcript: TranscriptEntry[];
  /** Send a message; resolves false if dropped (busy, empty, or not ready). */
  send: (text: string) => Promise<boolean>;
  /** Abort the in-flight turn. */
  abort: () => void;
  /** Read the agent's virtual workspace back out. */
  files: () => Record<string, string>;
  /**
   * Fraction (0..1) of the model's context window used by the last turn.
   * Meaningful for local engines (their window is a hard limit); refreshed
   * after each turn completes.
   */
  contextPct: number;
  /** Clear the conversation (keeps workspace files) and empty the transcript. */
  reset: () => void;
}

/**
 * `options` may change every render; the Chat is only (re)created when a field
 * that defines the agent changes. `files`/`tools`/`persist` are read from the
 * latest options at creation time.
 */
export function usePiChat(options: UsePiChatOptions): UsePiChatResult {
  const [chat, setChat] = useState<Chat | undefined>();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [contextPct, setContextPct] = useState(0);

  const chatRef = useRef<Chat | undefined>(undefined);
  const busyRef = useRef(false);
  const idRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const nextId = () => `m${idRef.current++}`;

  // An injected Provider object (e.g. a local @wepi/sdk/webllm engine) is keyless, so
  // it satisfies the auth gate on its own; cloud (string) providers need a key.
  const hasProviderObject = typeof options.provider === "object" && options.provider !== null;
  const hasAuth = !!(options.apiKey || options.baseUrl || options.getApiKey || hasProviderObject);
  const enabled = options.enabled !== false && hasAuth;

  // Create (and re-create) the Chat when the agent-defining options change.
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let created: Chat | undefined;
    void (async () => {
      try {
        const c = await createChat(optionsRef.current);
        if (disposed) {
          c.dispose();
          return;
        }
        created = c;
        chatRef.current = c;
        setChat(c);
        setContextPct(c.metrics.contextPct); // restored transcripts start non-zero
      } catch (err) {
        if (!disposed) setError(err);
      }
    })();
    return () => {
      disposed = true;
      created?.dispose();
      if (chatRef.current === created) chatRef.current = undefined;
      setChat(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    options.apiKey,
    options.baseUrl,
    options.model,
    options.provider,
    options.systemPrompt,
    options.sandbox,
    typeof options.persist === "string" ? options.persist : options.persist?.id,
  ]);

  const send = useCallback(async (text: string): Promise<boolean> => {
    const c = chatRef.current;
    const trimmed = text.trim();
    if (!c || busyRef.current || !trimmed) return false;

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

    // Batch streamed deltas into ~50ms flushes: a long reply arrives as
    // thousands of deltas, and a setState per delta re-renders the whole
    // transcript each time.
    let pending = "";
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (!pending) return;
      const chunk = pending;
      pending = "";
      patch((e) => ({ ...e, text: e.text + chunk }));
    };

    try {
      const turn = c.send(trimmed, {
        onTool: (ev: ToolEvent) => patch((e) => ({ ...e, tools: [...e.tools, ev] })),
      });
      for await (const delta of turn) {
        pending += delta;
        flushTimer ??= setTimeout(flush, 50);
      }
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      patch((e) => ({ ...e, streaming: false, text: turn.aborted ? e.text + "\n[stopped]" : e.text }));
    } catch (err) {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      setError(err);
      patch((e) => ({ ...e, streaming: false, text: `${e.text}\n[error] ${String(err)}` }));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setContextPct(chatRef.current?.metrics.contextPct ?? 0);
    }
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const abort = useCallback(() => chatRef.current?.abort(), []);
  const files = useCallback(() => chatRef.current?.files() ?? {}, []);
  const reset = useCallback(() => {
    chatRef.current?.reset();
    setTranscript([]);
    setContextPct(0);
  }, []);

  return { chat, ready: !!chat, busy, error, transcript, send, abort, files, contextPct, reset };
}
