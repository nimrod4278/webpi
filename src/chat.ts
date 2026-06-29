/**
 * `Chat` — the public object. Wraps a native, in-browser pi-agent-core `Agent`
 * (no emulation): a model (Claude by default), file tools over a virtual
 * workspace, and a `bash` tool backed by a pluggable Sandbox.
 */

import { Agent, convertToLlm } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { buildModel } from "./model.js";
import { VirtualFS, createFileTools } from "./tools/fs.js";
import { createBashTool } from "./tools/bash.js";
import { NullSandbox, type Sandbox } from "./sandbox.js";
import { Turn } from "./turn.js";

const DEFAULT_SYSTEM_PROMPT =
  "You are pi, a coding assistant running entirely in the user's browser. " +
  "You can read, write, edit, list, and search files in a virtual workspace, " +
  "and run shell commands with the bash tool when a sandbox is available. " +
  "Use these tools to complete the user's tasks.";

export interface ChatOptions {
  /** Provider API key (browser-direct). Required. */
  apiKey: string;
  /** Model id (default: a current Claude). */
  model?: string;
  /** pi-ai provider id (default: "anthropic"). */
  provider?: string;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Seed the virtual workspace, keyed by relative path. */
  files?: Record<string, string>;
  /** Backend for the bash/run tool (default: NullSandbox = bash unavailable). */
  sandbox?: Sandbox;
  /** Extra agent tools to expose. */
  tools?: AgentTool[];
}

/** Create a chat. Async to keep room for sandbox warm-up later. */
export async function createChat(options: ChatOptions): Promise<Chat> {
  return new Chat(options);
}

export class Chat {
  /** The agent's virtual workspace. */
  readonly fs: VirtualFS;

  private readonly agent: Agent;
  private current?: Turn;

  constructor(options: ChatOptions) {
    this.fs = new VirtualFS(options.files ?? {});
    const { model, streamFn, getApiKey } = buildModel({
      apiKey: options.apiKey,
      provider: options.provider,
      model: options.model,
    });
    const sandbox = options.sandbox ?? new NullSandbox();
    const tools: AgentTool[] = [
      ...createFileTools(this.fs),
      createBashTool(sandbox),
      ...(options.tools ?? []),
    ];
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        model,
        tools,
      },
      streamFn,
      getApiKey,
      convertToLlm,
    });
  }

  /** Send a message; returns a Turn you can stream (`for await`) or await. */
  send(message: string): Turn {
    const turn = new Turn(() => this.agent.abort());
    this.current = turn;
    const unsub = this.agent.subscribe((event) => turn.handleEvent(event));
    this.agent
      .prompt(message)
      .catch((err: unknown) => turn.fail(err))
      .finally(() => unsub());
    return turn;
  }

  /** Abort the in-flight turn, if any. */
  abort(): void {
    this.agent.abort();
  }

  /** Conversation transcript. */
  get messages(): readonly AgentMessage[] {
    return this.agent.state.messages;
  }

  /** Read the workspace back out, keyed by relative path. */
  files(): Record<string, string> {
    return this.fs.snapshot();
  }

  /** Tear down. */
  dispose(): void {
    this.agent.abort();
  }
}
