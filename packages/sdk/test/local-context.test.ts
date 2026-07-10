/**
 * Context budgeting for local engines. Local windows are HARD limits
 * (llama.cpp aborts the WASM runtime past n_ctx), so `fitToContextBudget`
 * must (1) clamp giant tool outputs, (2) drop the oldest rounds without ever
 * orphaning a `tool` message from the assistant `tool_calls` that produced it,
 * and (3) always keep the newest round. Also pins the usage-estimation
 * fallback: wllama never emits a `usage` chunk, and context accounting
 * (Chat.metrics.contextPct) is only real if runLocalStream estimates one.
 */
import { describe, expect, it } from "vitest";
import { fitToContextBudget, type ContextBudget } from "../src/engine/openai.js";
import { createWllamaProvider, type WllamaEngine } from "../src/engine/wllama.js";

/** A round: user ask → assistant tool_calls → tool result → assistant answer. */
function round(n: number, pad = 200): Record<string, unknown>[] {
  return [
    { role: "user", content: `question ${n} ${"q".repeat(pad)}` },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: `call_${n}`, content: `output ${n} ${"o".repeat(pad)}` },
    { role: "assistant", content: `answer ${n} ${"a".repeat(pad)}` },
  ];
}

/** Budget sized in chars for readability: budgetChars = (window − max − reserve) × 1. */
function budgetOfChars(chars: number): ContextBudget {
  return { contextWindow: chars, maxTokens: 0, reserveTokens: 0, charsPerToken: 1 };
}

describe("fitToContextBudget", () => {
  it("returns messages unchanged when they fit", () => {
    const messages = [...round(1), ...round(2)];
    const fitted = fitToContextBudget(messages, budgetOfChars(100_000));
    expect(fitted).toEqual(messages);
  });

  it("drops the oldest rounds first and marks the cut with a bridge message", () => {
    const messages = [...round(1), ...round(2), ...round(3)];
    const oneRound = JSON.stringify(round(3)).length;
    const fitted = fitToContextBudget(messages, budgetOfChars(oneRound * 2));

    expect(JSON.stringify(fitted)).not.toContain("question 1");
    expect(JSON.stringify(fitted)).toContain("question 3");
    expect(fitted[0].role).toBe("user");
    expect(String(fitted[0].content)).toMatch(/truncated/);
  });

  it("never orphans a tool message from its assistant tool_calls", () => {
    const messages = [...round(1), ...round(2), ...round(3), ...round(4)];
    // Sweep budgets so every possible cut point is exercised.
    for (let chars = 100; chars < JSON.stringify(messages).length; chars += 137) {
      const fitted = fitToContextBudget(messages, budgetOfChars(chars));
      for (const [i, m] of fitted.entries()) {
        if (m.role !== "tool") continue;
        const parent = fitted
          .slice(0, i)
          .find(
            (p) =>
              p.role === "assistant" &&
              Array.isArray(p.tool_calls) &&
              (p.tool_calls as { id: string }[]).some((c) => c.id === m.tool_call_id),
          );
        expect(parent, `tool ${String(m.tool_call_id)} orphaned at budget ${chars}`).toBeDefined();
      }
    }
  });

  it("always keeps the newest round, even over budget", () => {
    const messages = [...round(1), ...round(2)];
    const fitted = fitToContextBudget(messages, budgetOfChars(10));
    expect(JSON.stringify(fitted)).toContain("question 2");
    expect(JSON.stringify(fitted)).not.toContain("question 1");
  });

  it("clamps oversized tool outputs, keeping head and tail", () => {
    const big = `START${"x".repeat(30_000)}END`;
    const messages = [
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: big },
    ];
    const fitted = fitToContextBudget(messages, { contextWindow: 8192, maxTokens: 3072 });
    const tool = fitted.find((m) => m.role === "tool")!;
    const content = String(tool.content);
    expect(content.length).toBeLessThanOrEqual(8000);
    expect(content).toContain("START");
    expect(content).toContain("END");
    expect(content).toMatch(/truncated/);
  });
});

describe("usage estimation fallback", () => {
  function engineWithoutUsage(chunks: unknown[]): WllamaEngine {
    return {
      async createChatCompletion() {
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      },
    };
  }

  it("estimates usage when the engine never emits a usage chunk", async () => {
    const engine = engineWithoutUsage([
      { choices: [{ delta: { content: "a fairly long reply from the model" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const { provider } = await createWllamaProvider({ engine, modelId: "test" });
    const model = provider.getModels()[0];

    const final = await provider
      .stream(model, { messages: [{ role: "user", content: "hello there", timestamp: 0 } as never] }, {})
      .result();

    expect(final.usage.input).toBeGreaterThan(0);
    expect(final.usage.output).toBeGreaterThan(0);
    expect(final.usage.totalTokens).toBe(final.usage.input + final.usage.output);
  });
});
