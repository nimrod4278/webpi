import { describe, expect, it } from "vitest";
import { Turn } from "../src/turn.js";
import { WepiError } from "../src/errors.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

function delta(text: string): AgentEvent {
  return {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: text },
  } as unknown as AgentEvent;
}

function end(stopReason?: string, errorMessage?: string): AgentEvent {
  const messages = stopReason
    ? [{ role: "assistant", content: [], stopReason, errorMessage }]
    : [];
  return { type: "agent_end", messages } as unknown as AgentEvent;
}

describe("Turn", () => {
  it("resolves to the full reply when awaited", async () => {
    const turn = new Turn(() => {});
    turn.handleEvent(delta("Hello"));
    turn.handleEvent(delta(" world"));
    turn.handleEvent(end("stop"));
    expect(await turn).toBe("Hello world");
    expect(turn.settled).toBe(true);
    expect(turn.aborted).toBe(false);
  });

  it("streams text deltas when iterated", async () => {
    const turn = new Turn(() => {});
    const collected: string[] = [];
    const consume = (async () => {
      for await (const t of turn) collected.push(t);
    })();
    turn.handleEvent(delta("a"));
    turn.handleEvent(delta("b"));
    turn.handleEvent(end("stop"));
    await consume;
    expect(collected).toEqual(["a", "b"]);
  });

  it("calls onAbort when aborted", () => {
    let aborted = false;
    const turn = new Turn(() => (aborted = true));
    turn.abort();
    expect(aborted).toBe(true);
  });

  it("resolves with partial text and sets `aborted` on an aborted run", async () => {
    const turn = new Turn(() => {});
    turn.handleEvent(delta("partial"));
    turn.handleEvent(end("aborted"));
    expect(await turn).toBe("partial");
    expect(turn.aborted).toBe(true);
  });

  it("rejects with a classified WepiError on a provider error", async () => {
    const turn = new Turn(() => {});
    turn.handleEvent(end("error", "401 unauthorized: invalid api key"));
    await expect(turn).rejects.toMatchObject({ name: "WepiError", code: "auth" });
  });

  it("classifies rate-limit errors", async () => {
    const turn = new Turn(() => {});
    turn.handleEvent(end("error", "429 rate limit exceeded"));
    await expect(turn).rejects.toMatchObject({ code: "rate_limit" });
  });

  it("does not surface an unhandled rejection when only streamed", async () => {
    const turn = new Turn(() => {});
    const consume = (async () => {
      const got: string[] = [];
      try {
        for await (const t of turn) got.push(t);
      } catch (e) {
        return e;
      }
    })();
    turn.fail(new WepiError("boom", "provider"));
    // The stream throws; the internal done promise must not also blow up unhandled.
    const err = await consume;
    expect(err).toBeInstanceOf(WepiError);
    // Give the microtask queue a beat — an unhandled rejection would fail the test run.
    await new Promise((r) => setTimeout(r, 0));
  });
});
