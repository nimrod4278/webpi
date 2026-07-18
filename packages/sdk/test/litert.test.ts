/**
 * The @wepi/sdk/litert (Gemma 4 via LiteRT-LM) provider, exercised against a FAKE
 * engine (no WebGPU, no .litertlm download). Proves offline:
 *   1. Turn wiring: system + prior turns land in the conversation `preface`, the
 *      final turn is the `sendMessageStreaming` input `Message`, and pi-ai tools
 *      are forwarded as `preface.tools`.
 *   2. Multimodal: an image in a user message becomes a LiteRT image content
 *      item (data-URI in `path`) and flips `visionModalityEnabled`.
 *   3. Chunk -> AssistantMessageEvent translation for streamed text and a
 *      built-in function call (`message.tool_calls` -> pi-ai toolCall).
 *   4. Abort cancels the in-flight conversation mid-stream.
 *
 * These pin the `@litert-lm/core` (0.12) shapes — Message / MessageContentItem /
 * ConversationConfig / ToolCall — that the converters build against, so if the
 * runtime shifts, only the converters + this file change.
 */
import { describe, expect, it } from "vitest";
import { createLiteRTProvider, type LiteRTMessage, type LiteRTEngine } from "../src/engine/litert.js";

/** An engine that records the conversation config + streamed input, and replays chunks. */
function fakeEngine(chunks: LiteRTMessage[]): {
  engine: LiteRTEngine;
  calls: { config: any; input: any };
} {
  const calls: any = {};
  const engine: LiteRTEngine = {
    createConversation(config: any) {
      calls.config = config;
      return {
        sendMessageStreaming(input: any) {
          calls.input = input;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
        cancel() {},
      };
    },
  };
  return { engine, calls };
}

const TOOLS = [
  { name: "bash", description: "run a shell command", parameters: { type: "object", properties: {} } },
] as any;
const userMessage = { role: "user", content: "run hello world", timestamp: 0 } as any;

describe("@wepi/sdk/litert provider", () => {
  it("puts system + prior turns in the preface, sends the last turn, forwards tools", async () => {
    const { engine, calls } = fakeEngine([
      { content: [{ type: "text", text: "ok" }] },
      { content: [] },
    ]);
    const { provider } = await createLiteRTProvider({ engine, modelId: "gemma-4" });
    const model = provider.getModels()[0];

    const prior = { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 0 } as any;
    await provider
      .stream(model, { systemPrompt: "SYSTEM RULES", messages: [prior, userMessage], tools: TOOLS }, {})
      .result();

    // System is a real system message in the preface (Gemma 4 supports it), and
    // the prior assistant turn is there too; only the last user turn is the input.
    expect(calls.config.preface.messages[0]).toEqual({ role: "system", content: "SYSTEM RULES" });
    expect(calls.config.preface.messages[1].role).toBe("assistant");
    // Tools MUST be OpenAI function-wrapper shape — Gemma's template reads
    // `tool.function.{name,description,parameters}`.
    expect(calls.config.preface.tools).toEqual([
      {
        type: "function",
        function: { name: "bash", description: "run a shell command", parameters: { type: "object", properties: {} } },
      },
    ]);
    // Text-only turn is a plain string (the LiteRT/Gemma-template-friendly shape).
    expect(calls.input).toEqual({ role: "user", content: "run hello world" });
  });

  it("converts an image user message to a LiteRT image item and enables vision", async () => {
    const { engine, calls } = fakeEngine([{ content: [] }]);
    const { provider } = await createLiteRTProvider({ engine, modelId: "gemma-4" });
    const model = provider.getModels()[0];

    const imgMessage = {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "BASE64DATA", mimeType: "image/png" },
      ],
      timestamp: 0,
    } as any;

    await provider.stream(model, { messages: [imgMessage] }, {}).result();

    expect(calls.input).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", path: "data:image/png;base64,BASE64DATA" },
      ],
    });
    expect(calls.config.sessionConfig.visionModalityEnabled).toBe(true);
  });

  it("translates streamed text + a built-in function call into content", async () => {
    const { engine } = fakeEngine([
      { content: [{ type: "text", text: "Running it." }] },
      { role: "assistant", tool_calls: [{ function: { name: "bash", arguments: { command: "echo hi" } } }] },
      { content: [] },
    ]);
    const { provider } = await createLiteRTProvider({ engine, modelId: "gemma-4" });
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
  });

  it("cancels the in-flight conversation when aborted mid-stream", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const engine: LiteRTEngine = {
      createConversation() {
        return {
          sendMessageStreaming() {
            return (async function* () {
              yield { content: [{ type: "text", text: "partial" }] } as LiteRTMessage;
              controller.abort(); // abort arrives after the first chunk
              yield { content: [{ type: "text", text: "never seen" }] } as LiteRTMessage;
            })();
          },
          cancel() {
            cancelled = true;
          },
        };
      },
    };
    const { provider } = await createLiteRTProvider({ engine, modelId: "gemma-4" });
    const model = provider.getModels()[0];

    const final = await provider
      .stream(model, { messages: [userMessage] }, { signal: controller.signal })
      .result();

    expect(cancelled).toBe(true);
    expect(final.stopReason).toBe("aborted");
    expect((final.content.find((c) => c.type === "text") as any)?.text).toBe("partial");
  });

  it("requires a model source or a pre-created engine", async () => {
    await expect(createLiteRTProvider({})).rejects.toThrow(/model|engine/);
  });
});
