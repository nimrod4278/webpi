/**
 * buildModel's provider-agnostic wiring, fully offline. Cloud providers resolve
 * from pi-ai's static catalogs (no network); an injected `Provider` object (here
 * a faux provider) exercises the keyless local-model path and drives a real
 * tool-call turn end to end.
 */
import { describe, expect, it } from "vitest";
import { Agent, convertToLlm } from "@earendil-works/pi-agent-core";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { buildModel } from "../src/model.js";
import { WepiError } from "../src/errors.js";
import { VirtualFS, createFileTools } from "../src/tools/fs.js";
import { Turn } from "../src/turn.js";

describe("buildModel — cloud providers by string id", () => {
  it("resolves an OpenAI model from the catalog", () => {
    const { model } = buildModel({ provider: "openai", model: "gpt-5.1", apiKey: "sk-test" });
    expect(model.provider).toBe("openai");
    expect(model.id).toBe("gpt-5.1");
  });

  it("resolves a Google (Gemini) model from the catalog", () => {
    const { model } = buildModel({ provider: "google", model: "gemini-2.5-pro", apiKey: "k" });
    expect(model.provider).toBe("google");
    expect(model.id).toBe("gemini-2.5-pro");
  });

  it("defaults to Claude when no provider/model is given", () => {
    const { model } = buildModel({ apiKey: "sk-test" });
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-sonnet-4-5");
  });

  it("uses the provider's default model when only the provider is given", () => {
    const { model } = buildModel({ provider: "openai", apiKey: "k" });
    expect(model.provider).toBe("openai");
    expect(model.id).toBe("gpt-5.1");
  });

  it("throws WepiError('unknown') for an unregistered provider string", () => {
    expect(() => buildModel({ provider: "nope", apiKey: "k" })).toThrowError(
      expect.objectContaining({ code: "unknown" }) as unknown as Error,
    );
  });

  it("throws WepiError('unknown') for an unknown model id", () => {
    try {
      buildModel({ provider: "openai", model: "not-a-real-model", apiKey: "k" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WepiError);
      expect((err as WepiError).code).toBe("unknown");
    }
  });

  it("requires credentials for cloud providers", () => {
    try {
      buildModel({ provider: "openai", model: "gpt-5.1" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WepiError);
      expect((err as WepiError).code).toBe("auth");
    }
  });
});

describe("buildModel — injected Provider (local/custom path)", () => {
  it("accepts a Provider object with NO credentials (keyless)", () => {
    const faux = fauxProvider();
    const { model, getApiKey } = buildModel({ provider: faux.provider, model: faux.getModel().id });
    expect(model.provider).toBe(faux.getModel().provider);
    // keyless: no apiKey resolved, and no auth error thrown.
    expect(getApiKey("whatever")).toBeUndefined();
  });

  it("bypasses catalog lookup when given a full Model object", () => {
    const faux = fauxProvider();
    const { model } = buildModel({ provider: faux.provider, model: faux.getModel() });
    expect(model.id).toBe(faux.getModel().id);
  });

  it("drives a full tool-call turn through the injected provider's streamFn", async () => {
    const fs = new VirtualFS();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "hi" })]),
      fauxAssistantMessage("Wrote hello.txt."),
    ]);

    const { model, streamFn, getApiKey } = buildModel({
      provider: faux.provider,
      model: faux.getModel(),
    });

    const agent = new Agent({
      initialState: { systemPrompt: "test", model, tools: createFileTools(fs) },
      streamFn,
      getApiKey,
      convertToLlm,
    });

    const turn = new Turn(() => agent.abort());
    const unsub = agent.subscribe((e) => turn.handleEvent(e));
    await agent.prompt("create hello.txt");
    unsub();
    const reply = await turn;

    expect(fs.read("hello.txt")).toBe("hi");
    expect(reply).toContain("Wrote hello.txt");
  });
});
