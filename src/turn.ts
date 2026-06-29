/**
 * `Turn` is what `chat.send()` returns. It is BOTH:
 *   - an `AsyncIterable<string>` yielding assistant text deltas as they stream
 *   - a `Promise<string>` resolving to the full assistant reply on `agent_end`
 *
 * It consumes pi-agent-core's `AgentEvent`s for the duration of one prompt.
 */

import { AsyncQueue } from "./async-queue.js";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export class Turn implements AsyncIterable<string>, PromiseLike<string> {
  private readonly deltas = new AsyncQueue<string>();
  private chunks: string[] = [];
  private messages: AgentMessage[] = [];
  private settled = false;
  private readonly done: Promise<string>;
  private resolveDone!: (text: string) => void;
  private rejectDone!: (err: unknown) => void;

  constructor(private readonly onAbort: () => void) {
    this.done = new Promise<string>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  /** Stop this turn. */
  abort(): void {
    this.onAbort();
  }

  /** Messages produced during this turn (available after it completes). */
  get newMessages(): AgentMessage[] {
    return this.messages;
  }

  // AsyncIterable: stream text deltas
  [Symbol.asyncIterator](): AsyncIterator<string> {
    return this.deltas[Symbol.asyncIterator]();
  }

  // PromiseLike: await the full reply
  then<TResult1 = string, TResult2 = never>(
    onfulfilled?: ((value: string) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.done.then(onfulfilled, onrejected);
  }

  /** Fed each agent event by the Chat for the duration of this turn. */
  handleEvent(event: AgentEvent): void {
    if (this.settled) return;
    switch (event.type) {
      case "message_update": {
        const sub = (event as { assistantMessageEvent?: { type: string; delta?: string } })
          .assistantMessageEvent;
        if (sub?.type === "text_delta" && typeof sub.delta === "string") {
          this.chunks.push(sub.delta);
          this.deltas.push(sub.delta);
        } else if (sub?.type === "error") {
          this.fail(new Error("pi reported a streaming error"));
        }
        break;
      }
      case "agent_end": {
        const msgs = (event as { messages?: AgentMessage[] }).messages;
        if (Array.isArray(msgs)) this.messages = msgs;
        this.complete();
        break;
      }
    }
  }

  /** Fail the turn (e.g. the prompt rejected). */
  fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.deltas.fail(error);
    this.rejectDone(error);
  }

  private complete(): void {
    if (this.settled) return;
    this.settled = true;
    this.deltas.close();
    this.resolveDone(this.chunks.join(""));
  }
}
