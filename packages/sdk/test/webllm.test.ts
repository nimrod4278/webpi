/**
 * The wepi/webllm provider, exercised against a FAKE engine (no WebGPU, no
 * weight download). Proves two things offline:
 *   1. The system-prompt/tools workaround: WebLLM function-calling models reject
 *      a custom `system` message when `tools` are set, so when tools are present
 *      the system prompt is folded into the first user turn (no `system` role).
 *   2. The chunk → AssistantMessageEvent translation (text + tool call).
 */
import { describe, expect, it } from "vitest";
import { createWebLLMProvider, type WebLLMEngine } from "../src/engine/webllm.js";

/** An engine that records requests and replays a scripted chunk stream. */
function fakeEngine(chunks: unknown[]): { engine: WebLLMEngine; requests: any[] } {
  const requests: any[] = [];
  const engine: WebLLMEngine = {
    chat: {
      completions: {
        async create(req: any) {
          requests.push(req);
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  return { engine, requests };
}

const TOOLS = [{ name: "bash", description: "run a shell command", parameters: { type: "object", properties: {} } }] as any;
const userMessage = { role: "user", content: "run hello world", timestamp: 0 } as any;

describe("wepi/webllm provider", () => {
  it("folds the system prompt into the first user turn when tools are present", async () => {
    const { engine, requests } = fakeEngine([
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const { provider } = await createWebLLMProvider({ engine, model: "test" });
    const model = provider.getModels()[0];

    await provider
      .stream(model, { systemPrompt: "SYSTEM RULES", messages: [userMessage], tools: TOOLS }, {})
      .result();

    const sent = requests[0];
    // No `system` role (that's what WebLLM's Hermes FC rejects)...
    expect(sent.messages.some((m: any) => m.role === "system")).toBe(false);
    // ...instead the system prompt rides in the first user message.
    const firstUser = sent.messages.find((m: any) => m.role === "user");
    expect(firstUser.content).toContain("SYSTEM RULES");
    expect(firstUser.content).toContain("run hello world");
    // Tools are forwarded in OpenAI shape.
    expect(sent.tools).toHaveLength(1);
    expect(sent.tools[0].function.name).toBe("bash");
  });

  it("keeps a normal system message when there are no tools", async () => {
    const { engine, requests } = fakeEngine([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const { provider } = await createWebLLMProvider({ engine, model: "test" });
    const model = provider.getModels()[0];

    await provider.stream(model, { systemPrompt: "SYSTEM RULES", messages: [userMessage] }, {}).result();

    const sent = requests[0];
    expect(sent.messages[0]).toEqual({ role: "system", content: "SYSTEM RULES" });
  });

  it("translates streamed chunks into text + tool-call content", async () => {
    const { engine } = fakeEngine([
      { choices: [{ delta: { content: "Running it." } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command":' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"echo hi"}' } }] } }] },
      {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      },
    ]);
    const { provider } = await createWebLLMProvider({ engine, model: "test" });
    const model = provider.getModels()[0];

    const final = await provider
      .stream(model, { systemPrompt: "sys", messages: [userMessage], tools: TOOLS }, {})
      .result();

    const text = final.content.find((c) => c.type === "text");
    const call = final.content.find((c) => c.type === "toolCall");
    expect((text as any).text).toBe("Running it.");
    expect((call as any).name).toBe("bash");
    expect((call as any).arguments).toEqual({ command: "echo hi" });
    expect(final.stopReason).toBe("toolUse");
    expect(final.usage.input).toBe(10);
    expect(final.usage.output).toBe(4);
  });

  it("dispose() unloads the engine exactly once (idempotent)", async () => {
    let unloads = 0;
    const { engine } = fakeEngine([]);
    engine.unload = async () => {
      unloads++;
    };
    const { dispose } = await createWebLLMProvider({ engine, model: "test" });
    await dispose();
    await dispose();
    expect(unloads).toBe(1);
  });
});
