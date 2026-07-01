/**
 * Offline end-to-end proof of the real architecture: a native pi-agent-core
 * `Agent` drives our file tools using pi-ai's FAUX provider (no network). The
 * model "calls" the write tool, the tool runs against the virtual FS, then the
 * agent streams a final reply — exactly what Chat does, minus the live LLM.
 */
import { describe, expect, it } from "vitest";
import { Agent, convertToLlm } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { VirtualFS, createFileTools } from "../src/tools/fs.js";
import { Turn } from "../src/turn.js";

describe("Agent + tools (offline, faux model)", () => {
  it("executes a tool call, then streams a final reply", async () => {
    const fs = new VirtualFS();

    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      // Turn 1: the model calls our `write` tool.
      fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "hi there" })]),
      // Turn 2: after the tool result, it replies with text.
      fauxAssistantMessage("Wrote hello.txt for you."),
    ]);

    const agent = new Agent({
      initialState: { systemPrompt: "test", model: faux.getModel(), tools: createFileTools(fs) },
      streamFn: (m, ctx, opts) => models.stream(m, ctx, opts),
      convertToLlm,
    });

    const turn = new Turn(() => agent.abort());
    const unsub = agent.subscribe((e) => turn.handleEvent(e));
    await agent.prompt("create hello.txt with 'hi there'");
    unsub();
    const reply = await turn;

    // The tool actually ran against the virtual workspace:
    expect(fs.read("hello.txt")).toBe("hi there");
    // And the final assistant text streamed through the Turn:
    expect(reply).toContain("Wrote hello.txt");
  });
});
