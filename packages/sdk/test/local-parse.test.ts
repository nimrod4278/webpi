/**
 * Tool-call argument parsing for local engines (src/engine/openai.ts).
 * Small models routinely emit malformed or length-truncated tool-call JSON;
 * these tests pin down the repair ladder and the INVALID_TOOL_ARGS sentinel
 * that turns silent `{}` failures into self-correcting feedback, plus the
 * low-temperature default applied when tools are present.
 */
import { describe, expect, it, vi } from "vitest";
import { INVALID_TOOL_ARGS, parseToolArguments } from "../src/engine/openai.js";
import { createWllamaProvider, type WllamaEngine } from "../src/engine/wllama.js";

function fakeEngine(chunks: unknown[]): { engine: WllamaEngine; requests: any[] } {
  const requests: any[] = [];
  const engine: WllamaEngine = {
    async createChatCompletion(req: any) {
      requests.push(req);
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
  return { engine, requests };
}

const TOOLS = [{ name: "bash", description: "run a shell command", parameters: { type: "object", properties: {} } }] as any;
const userMessage = { role: "user", content: "hi", timestamp: 0 } as any;

describe("parseToolArguments", () => {
  it("parses well-formed JSON", () => {
    expect(parseToolArguments('{"command":"echo hi"}', false)).toEqual({ command: "echo hi" });
  });

  it("returns {} for empty arguments", () => {
    expect(parseToolArguments("", false)).toEqual({});
    expect(parseToolArguments("   ", true)).toEqual({});
  });

  it("strips a Markdown code fence", () => {
    expect(parseToolArguments('```json\n{"path":"a.ts"}\n```', false)).toEqual({ path: "a.ts" });
  });

  it("drops prose surrounding the JSON object", () => {
    expect(
      parseToolArguments('Sure! Here are the arguments: {"path":"a.ts","content":"x"} Hope that helps.', false),
    ).toEqual({ path: "a.ts", content: "x" });
  });

  it("closes truncated JSON when the output hit max_tokens", () => {
    expect(parseToolArguments('{"path":"dashboard.html","content":"<html><body', true)).toEqual({
      path: "dashboard.html",
      content: "<html><body",
    });
    expect(parseToolArguments('{"charts":[{"type":"bar"', true)).toEqual({ charts: [{ type: "bar" }] });
  });

  it("does NOT close truncated JSON without the length signal", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const args = parseToolArguments('{"path":"a.ts","content":"unfinished', false);
      expect(args[INVALID_TOOL_ARGS]).toMatch(/not valid JSON/);
      expect(args[INVALID_TOOL_ARGS]).not.toMatch(/max_tokens/);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns the sentinel with the raw snippet and a truncation hint on unrepairable input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const args = parseToolArguments('{"path": "a.ts" content: broken', true);
      const message = args[INVALID_TOOL_ARGS] as string;
      expect(message).toMatch(/not valid JSON/);
      expect(message).toMatch(/max_tokens/);
      expect(message).toContain('{"path": "a.ts" content: broken');
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects non-object JSON (arrays, scalars) with the sentinel", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseToolArguments('["not","args"]', false)[INVALID_TOOL_ARGS]).toBeDefined();
      expect(parseToolArguments('"just a string"', false)[INVALID_TOOL_ARGS]).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("runLocalStream argument finalization", () => {
  it("carries the sentinel through a streamed malformed tool call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { engine } = fakeEngine([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: '{"command" echo' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: " oops}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);
      const { provider } = await createWllamaProvider({ engine, modelId: "test" });
      const model = provider.getModels()[0];

      const final = await provider.stream(model, { messages: [userMessage], tools: TOOLS }, {}).result();
      const call = final.content.find((c) => c.type === "toolCall") as any;
      expect(call.arguments[INVALID_TOOL_ARGS]).toMatch(/not valid JSON/);
      expect(final.stopReason).toBe("toolUse");
    } finally {
      warn.mockRestore();
    }
  });

  it("repairs a tool call truncated by max_tokens (finish_reason length)", async () => {
    const { engine } = fakeEngine([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write", arguments: '{"path":"a.html","content":"<html>' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]);
    const { provider } = await createWllamaProvider({ engine, modelId: "test" });
    const model = provider.getModels()[0];

    const final = await provider.stream(model, { messages: [userMessage], tools: TOOLS }, {}).result();
    const call = final.content.find((c) => c.type === "toolCall") as any;
    expect(call.arguments).toEqual({ path: "a.html", content: "<html>" });
    // The (repaired) tool call still routes through the loop as toolUse.
    expect(final.stopReason).toBe("toolUse");
  });
});

describe("local temperature default", () => {
  it("defaults temperature to 0.2 when tools are present", async () => {
    const { engine, requests } = fakeEngine([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    const { provider } = await createWllamaProvider({ engine, modelId: "test" });
    const model = provider.getModels()[0];

    await provider.stream(model, { messages: [userMessage], tools: TOOLS }, {}).result();
    expect(requests[0].temperature).toBe(0.2);
  });

  it("leaves temperature unset without tools", async () => {
    const { engine, requests } = fakeEngine([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    const { provider } = await createWllamaProvider({ engine, modelId: "test" });
    const model = provider.getModels()[0];

    await provider.stream(model, { messages: [userMessage] }, {}).result();
    expect(requests[0].temperature).toBeUndefined();
  });

  it("lets an explicit caller temperature win", async () => {
    const { engine, requests } = fakeEngine([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
    const { provider } = await createWllamaProvider({ engine, modelId: "test" });
    const model = provider.getModels()[0];

    await provider.stream(model, { messages: [userMessage], tools: TOOLS }, { temperature: 0.9 }).result();
    expect(requests[0].temperature).toBe(0.9);
  });
});
