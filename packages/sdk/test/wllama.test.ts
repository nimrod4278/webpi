/**
 * The @wepi/sdk/wllama provider, exercised against a FAKE engine (no WASM, no GGUF
 * download). Proves three things offline:
 *   1. Request wiring: OpenAI-shaped params + the abort signal are forwarded to
 *      `createChatCompletion` (wllama takes `abortSignal` in-band).
 *   2. Unlike webllm, the system prompt stays a real `system` message even when
 *      tools are present (llama.cpp chat templates accept both).
 *   3. The chunk → AssistantMessageEvent translation (text + tool call), which
 *      is shared with webllm via src/engine/openai.ts.
 */
import { describe, expect, it } from "vitest";
import { createWllamaProvider, type WllamaEngine } from "../src/engine/wllama.js";

/** An engine that records requests and replays a scripted chunk stream. */
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
const userMessage = { role: "user", content: "run hello world", timestamp: 0 } as any;

describe("@wepi/sdk/wllama provider", () => {
  it("keeps a real system message even when tools are present", async () => {
    const { engine, requests } = fakeEngine([
      { choices: [{ delta: { content: "ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const { provider } = await createWllamaProvider({ engine, modelId: "test" });
    const model = provider.getModels()[0];

    await provider
      .stream(model, { systemPrompt: "SYSTEM RULES", messages: [userMessage], tools: TOOLS }, {})
      .result();

    const sent = requests[0];
    expect(sent.messages[0]).toEqual({ role: "system", content: "SYSTEM RULES" });
    // Tools are forwarded in OpenAI shape, with streaming enabled.
    expect(sent.tools).toHaveLength(1);
    expect(sent.tools[0].function.name).toBe("bash");
    expect(sent.tool_choice).toBe("auto");
    expect(sent.stream).toBe(true);
  });

  it("enables llama.cpp prompt caching on every request", async () => {
    const { engine, requests } = fakeEngine([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const { provider } = await createWllamaProvider({ engine, modelId: "test" });
    const model = provider.getModels()[0];

    await provider.stream(model, { messages: [userMessage] }, {}).result();

    // Without cache_prompt llama.cpp re-prefills the whole conversation each
    // turn — the dominant TTFT cost in the agent loop.
    expect(requests[0].cache_prompt).toBe(true);
  });

  it("forwards the abort signal in-band as `abortSignal`", async () => {
    const { engine, requests } = fakeEngine([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const { provider } = await createWllamaProvider({ engine, modelId: "test" });
    const model = provider.getModels()[0];
    const controller = new AbortController();

    await provider
      .stream(model, { messages: [userMessage] }, { signal: controller.signal })
      .result();

    expect(requests[0].abortSignal).toBe(controller.signal);
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
    const { provider } = await createWllamaProvider({ engine, modelId: "test" });
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

  it("requires a model source or a pre-loaded engine", async () => {
    await expect(createWllamaProvider({})).rejects.toThrow(/model source|engine/);
    await expect(createWllamaProvider({ repo: "some/repo" })).rejects.toThrow(/wasmUrl/);
  });

  it("dispose() frees the engine exactly once (idempotent)", async () => {
    let exits = 0;
    const engine: WllamaEngine = {
      async createChatCompletion() {
        return (async function* () {})();
      },
      async exit() {
        exits++;
      },
    };
    const { dispose } = await createWllamaProvider({ engine, modelId: "test" });
    await dispose();
    await dispose();
    expect(exits).toBe(1);
  });

  it("dispose() is a no-op for engines without exit()", async () => {
    const { engine } = fakeEngine([]);
    const { dispose } = await createWllamaProvider({ engine, modelId: "test" });
    await expect(dispose()).resolves.toBeUndefined();
  });
});
