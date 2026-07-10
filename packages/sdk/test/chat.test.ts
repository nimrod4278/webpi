/**
 * Chat-level behavior with a faux (offline) model: the busy guard and the
 * ChatStore persistence round trip. `buildModel` is mocked so each test wires
 * its own faux provider responses.
 */
import { describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createChat, Chat } from "../src/chat.js";
import { INVALID_TOOL_ARGS } from "../src/engine/openai.js";
import type { VirtualFS } from "../src/tools/fs.js";
import type { ChatSnapshot, ChatStore } from "../src/store/index.js";

const holder = vi.hoisted(() => ({
  build: null as null | (() => unknown),
}));

vi.mock("../src/model.js", () => ({
  buildModel: () => holder.build!(),
}));

function useFauxModel(responses: unknown[]): void {
  holder.build = () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(responses as never);
    return {
      model: faux.getModel(),
      streamFn: (m: never, ctx: never, opts: never) => models.stream(m, ctx, opts),
      getApiKey: () => "test-key",
    };
  };
}

class MemoryStore implements ChatStore {
  data = new Map<string, ChatSnapshot>();
  saves = 0;
  async load(id: string): Promise<ChatSnapshot | null> {
    return this.data.get(id) ?? null;
  }
  async save(id: string, snapshot: ChatSnapshot): Promise<void> {
    this.saves++;
    this.data.set(id, snapshot);
  }
}

describe("Chat", () => {
  it("throws a busy WepiError on a second send while a turn is in flight", async () => {
    useFauxModel([fauxAssistantMessage("first reply")]);
    const chat = new Chat({ apiKey: "x" });
    const turn = chat.send("hello");
    expect(() => chat.send("too eager")).toThrowError(/already in flight/);
    try {
      expect(() => chat.send("too eager")).toThrowError(
        expect.objectContaining({ code: "busy" }),
      );
    } finally {
      await turn;
      chat.dispose();
    }
  });

  it("allows a new send after the previous turn settles", async () => {
    useFauxModel([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
    const chat = new Chat({ apiKey: "x" });
    expect(await chat.send("a")).toBe("one");
    expect(await chat.send("b")).toBe("two");
    chat.dispose();
  });

  it("persists a snapshot per turn and restores it in a new Chat", async () => {
    const store = new MemoryStore();

    useFauxModel([
      fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "hi" })]),
      fauxAssistantMessage("Wrote hello.txt."),
    ]);
    const chat = await createChat({ apiKey: "x", persist: { id: "t1", store } });
    await chat.send("create hello.txt");
    await vi.waitFor(() => expect(store.saves).toBeGreaterThan(0));
    chat.dispose();

    const snap = store.data.get("t1")!;
    expect(snap.version).toBe(1);
    expect(snap.files["hello.txt"]).toBe("hi");
    expect(snap.messages.length).toBeGreaterThan(0);

    // A fresh Chat with the same id resumes with the workspace and transcript.
    useFauxModel([]);
    const resumed = await createChat({ apiKey: "x", persist: { id: "t1", store } });
    expect(resumed.files()["hello.txt"]).toBe("hi");
    expect(resumed.messages.length).toBe(snap.messages.length);
    resumed.dispose();
  });

  it("exposes raw agent events via subscribe", async () => {
    useFauxModel([fauxAssistantMessage("hi")]);
    const chat = new Chat({ apiKey: "x" });
    const types: string[] = [];
    const unsub = chat.subscribe((e) => types.push(e.type));
    await chat.send("hello");
    unsub();
    expect(types).toContain("agent_start");
    expect(types).toContain("agent_end");
    chat.dispose();
  });

  it("blocks tool calls carrying the INVALID_TOOL_ARGS sentinel with corrective feedback", async () => {
    // `ls` takes no required params, so `{}` from a botched parse would
    // otherwise pass schema validation and execute silently.
    useFauxModel([
      fauxAssistantMessage([fauxToolCall("ls", { [INVALID_TOOL_ARGS]: "Tool call arguments were not valid JSON." })]),
      fauxAssistantMessage("Sorry, retrying."),
    ]);
    const chat = new Chat({ apiKey: "x" });
    await chat.send("list files");
    const transcript = JSON.stringify(chat.messages);
    expect(transcript).toContain("not valid JSON");
    expect(transcript).toContain("Re-issue the tool call");
    chat.dispose();
  });

  it("defaultTools: false hides the built-in tools", async () => {
    useFauxModel([
      fauxAssistantMessage([fauxToolCall("ls", {})]),
      fauxAssistantMessage("done"),
    ]);
    const chat = new Chat({ apiKey: "x", defaultTools: false });
    await chat.send("list files");
    expect(JSON.stringify(chat.messages)).toContain("Tool ls not found");
    chat.dispose();
  });

  it("resolves a tools factory with the chat's VirtualFS", async () => {
    const params = Type.Object({});
    const makeTools = (fs: VirtualFS): AgentTool[] => [
      {
        name: "make_artifact",
        label: "Make artifact",
        description: "Write a fixed artifact into the workspace.",
        parameters: params,
        execute: async () => {
          fs.write("artifact.html", "<html/>");
          return { content: [{ type: "text", text: "ok" }], details: undefined };
        },
      } as AgentTool,
    ];
    useFauxModel([
      fauxAssistantMessage([fauxToolCall("make_artifact", {})]),
      fauxAssistantMessage("made it"),
    ]);
    const chat = new Chat({ apiKey: "x", defaultTools: false, tools: makeTools });
    await chat.send("make the artifact");
    expect(chat.files()["artifact.html"]).toBe("<html/>");
    chat.dispose();
  });

  it("reset() clears the conversation but keeps the workspace, and persists", async () => {
    const store = new MemoryStore();
    useFauxModel([
      fauxAssistantMessage([fauxToolCall("write", { path: "dash.html", content: "<html/>" })]),
      fauxAssistantMessage("Built the dashboard."),
    ]);
    const chat = await createChat({ apiKey: "x", persist: { id: "r1", store } });
    await chat.send("build a dashboard");
    expect(chat.messages.length).toBeGreaterThan(0);

    chat.reset();

    expect(chat.messages).toHaveLength(0);
    expect(chat.metrics.contextPct).toBe(0);
    expect(chat.files()["dash.html"]).toBe("<html/>");
    await vi.waitFor(() => expect(store.data.get("r1")!.messages).toHaveLength(0));
    expect(store.data.get("r1")!.files["dash.html"]).toBe("<html/>");
    chat.dispose();
  });
});
