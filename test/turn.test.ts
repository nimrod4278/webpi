import { describe, expect, it } from "vitest";
import { Turn } from "../src/turn.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

function delta(text: string): AgentEvent {
  return {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: text },
  } as unknown as AgentEvent;
}

describe("Turn", () => {
  it("resolves to the full reply when awaited", async () => {
    const turn = new Turn(() => {});
    turn.handleEvent(delta("Hello"));
    turn.handleEvent(delta(" world"));
    turn.handleEvent({ type: "agent_end", messages: [] });
    expect(await turn).toBe("Hello world");
  });

  it("streams text deltas when iterated", async () => {
    const turn = new Turn(() => {});
    const collected: string[] = [];
    const consume = (async () => {
      for await (const t of turn) collected.push(t);
    })();
    turn.handleEvent(delta("a"));
    turn.handleEvent(delta("b"));
    turn.handleEvent({ type: "agent_end", messages: [] });
    await consume;
    expect(collected).toEqual(["a", "b"]);
  });

  it("calls onAbort when aborted", () => {
    let aborted = false;
    const turn = new Turn(() => (aborted = true));
    turn.abort();
    expect(aborted).toBe(true);
  });

  it("rejects on a streaming error event", async () => {
    const turn = new Turn(() => {});
    turn.handleEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "error" },
    });
    await expect(turn).rejects.toThrow();
  });
});
