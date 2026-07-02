/**
 * `Turn` is what `chat.send()` returns. It is BOTH:
 *   - an `AsyncIterable<string>` yielding assistant text deltas as they stream
 *   - a `Promise<string>` resolving to the full assistant reply on `agent_end`
 *
 * It consumes pi-agent-core's `AgentEvent`s for the duration of one prompt.
 *
 * Settlement: an aborted turn RESOLVES with the partial text (check
 * `turn.aborted`) — stopping is not an error. A provider failure REJECTS with
 * a `WepiError` whose `code` distinguishes auth / rate-limit / other.
 */

import { AsyncQueue } from "./async-queue.js";
import { WepiError, classifyProviderError } from "./errors.js";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

/** Tool activity surfaced alongside the text stream, so a UI can show it. */
export type ToolEvent =
  | { type: "start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

export class Turn implements AsyncIterable<string>, PromiseLike<string> {
  private readonly deltas = new AsyncQueue<string>();
  private chunks: string[] = [];
  private messages: AgentMessage[] = [];
  private _settled = false;
  private _aborted = false;
  private readonly done: Promise<string>;
  private resolveDone!: (text: string) => void;
  private rejectDone!: (err: unknown) => void;

  constructor(
    private readonly onAbort: () => void,
    private readonly onTool?: (event: ToolEvent) => void,
  ) {
    this.done = new Promise<string>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    // A consumer that only streams (`for await`) never touches the promise —
    // keep its rejection from surfacing as an unhandled rejection.
    this.done.catch(() => {});
  }

  /** Stop this turn. The turn resolves with the partial text; `aborted` is set. */
  abort(): void {
    this.onAbort();
  }

  /** True once the turn has resolved or rejected. */
  get settled(): boolean {
    return this._settled;
  }

  /** True when the turn was stopped via `abort()` (it resolves with partial text). */
  get aborted(): boolean {
    return this._aborted;
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
    if (this._settled) return;
    switch (event.type) {
      case "message_update": {
        const sub = event.assistantMessageEvent;
        if (sub.type === "text_delta") {
          this.chunks.push(sub.delta);
          this.deltas.push(sub.delta);
        }
        break;
      }
      case "tool_execution_start":
        this.onTool?.({
          type: "start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_end":
        this.onTool?.({
          type: "end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
        break;
      case "agent_end": {
        this.messages = event.messages;
        // The final assistant message carries the outcome: retries happen
        // upstream, so by agent_end the stop reason is authoritative.
        const last = [...event.messages]
          .reverse()
          .find((m): m is AgentMessage & { stopReason: string; errorMessage?: string } =>
            (m as { role?: string }).role === "assistant" && "stopReason" in m,
          );
        if (last?.stopReason === "aborted") {
          this._aborted = true;
          this.complete();
        } else if (last?.stopReason === "error") {
          const msg = last.errorMessage ?? "the provider reported an error";
          this.fail(new WepiError(msg, classifyProviderError(msg)));
        } else {
          this.complete();
        }
        break;
      }
    }
  }

  /** Fail the turn (e.g. the prompt rejected). */
  fail(error: unknown): void {
    if (this._settled) return;
    this._settled = true;
    this.deltas.fail(error);
    this.rejectDone(error);
  }

  private complete(): void {
    if (this._settled) return;
    this._settled = true;
    this.deltas.close();
    this.resolveDone(this.chunks.join(""));
  }
}
