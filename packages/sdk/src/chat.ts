/**
 * `Chat` — the public object. Wraps a native, in-browser pi-agent-core `Agent`
 * (no emulation): a model (Claude by default), file tools over a virtual
 * workspace, and a `bash` tool backed by a pluggable Sandbox. When a real
 * sandbox is attached, the workspace is mirrored into it around every bash
 * command, so file tools and shell commands see one filesystem.
 */

import { Agent, convertToLlm } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { buildModel } from "./model.js";
import { INVALID_TOOL_ARGS } from "./engine/openai.js";
import { VirtualFS, createFileTools } from "./tools/fs.js";
import { createBashTool } from "./tools/bash.js";
import { NullSandbox, type Sandbox } from "./sandbox/index.js";
import { Turn, type ToolEvent } from "./turn.js";
import { WepiError } from "./errors.js";
import type { ChatSnapshot, ChatStore } from "./store/index.js";
import { IndexedDBStore } from "./store/indexeddb.js";

const DEFAULT_WORKDIR = "/workspace";

/** Built-in tool names selectable via `ChatOptions.defaultTools`. */
export type DefaultToolName = "read" | "write" | "edit" | "ls" | "grep" | "bash";

/** Consecutive unparseable tool calls before the model is told to stop trying. */
const MAX_INVALID_TOOL_CALL_STREAK = 3;

function defaultSystemPrompt(workdir: string): string {
  return (
    "You are pi, a coding assistant running entirely in the user's browser. " +
    "You can read, write, edit, list, and search files in a workspace, and run " +
    `shell commands with the bash tool. The workspace is mounted at ${workdir} ` +
    "inside the shell (its current directory) — files you write are visible to " +
    "bash commands and vice versa. Use these tools to complete the user's tasks."
  );
}

export interface ChatOptions {
  /** Provider API key (browser-direct). Optional when `baseUrl` or `getApiKey` is set. */
  apiKey?: string;
  /** Resolve the API key per request — e.g. a short-lived token from your backend. */
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  /** Route provider requests through your own endpoint (proxy injects the key). */
  baseUrl?: string;
  /** Model id from the provider catalog (default: a sensible per-provider choice), or a full pi-ai `Model` object. */
  model?: string | Model<Api>;
  /**
   * Cloud provider id (default: "anthropic"; also openai, google, mistral, groq,
   * xai, deepseek, openrouter), or a pi-ai `Provider` object for anything else —
   * incl. a local engine from `wepi/webllm`.
   */
  provider?: string | Provider;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Seed the virtual workspace, keyed by relative path. */
  files?: Record<string, string>;
  /** Backend for the bash tool (default: NullSandbox = bash unavailable). */
  sandbox?: Sandbox;
  /** Where the workspace is mirrored inside the sandbox (default /workspace). */
  workdir?: string;
  /**
   * Extra agent tools to expose. Pass a function to receive the chat's
   * VirtualFS — for app tools that write artifacts into the workspace.
   */
  tools?: AgentTool[] | ((fs: VirtualFS) => AgentTool[]);
  /**
   * Which built-in tools to expose (default: all). Pass a subset to shrink the
   * schema overhead for small on-device models, or `false` for none — e.g. an
   * app that provides its own single-purpose tool via `tools`. Excluding
   * "bash" skips the sandbox-backed shell entirely.
   */
  defaultTools?: DefaultToolName[] | false;
  /**
   * Persist the conversation + workspace and resume on reload. A string id
   * uses the built-in IndexedDB store; pass `{ id, store }` to plug any
   * backend implementing ChatStore.
   */
  persist?: string | { id: string; store: ChatStore };
  /** Called when a background snapshot save fails (default: console.warn). */
  onPersistError?: (error: unknown) => void;
}

export interface SendOptions {
  /** Observe tool calls (e.g. `bash`) as they start and finish, for UI display. */
  onTool?: (event: ToolEvent) => void;
}

/** Token/cost accounting across the conversation so far. */
export interface ChatMetrics {
  /** Assistant turns completed. */
  turns: number;
  /** Input tokens (including cache reads/writes) across all turns. */
  tokensIn: number;
  /** Output tokens across all turns. */
  tokensOut: number;
  /** Total cost in USD, as reported by the provider catalog. */
  costUsd: number;
  /** Fraction (0..1) of the model's context window used by the last turn. */
  contextPct: number;
}

/**
 * Create a chat. Restores the persisted snapshot first when `persist` is set —
 * construct `new Chat(...)` directly only if you don't need persistence.
 */
export async function createChat(options: ChatOptions): Promise<Chat> {
  const chat = new Chat(options);
  await chat.restore();
  return chat;
}

export class Chat {
  /** The agent's virtual workspace. Observable via `fs.onChange`. */
  readonly fs: VirtualFS;

  private readonly agent: Agent;
  private readonly contextWindow: number;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly persistId?: string;
  private readonly store?: ChatStore;
  private readonly onPersistError: (error: unknown) => void;
  private current?: Turn;
  private restored = false;
  private invalidToolCallStreak = 0;

  constructor(options: ChatOptions) {
    this.fs = new VirtualFS(options.files ?? {});
    const workdir = options.workdir ?? DEFAULT_WORKDIR;
    const { model, streamFn, getApiKey } = buildModel({
      apiKey: options.apiKey,
      getApiKey: options.getApiKey,
      baseUrl: options.baseUrl,
      provider: options.provider,
      model: options.model,
    });
    this.contextWindow = model.contextWindow;

    if (options.persist) {
      if (typeof options.persist === "string") {
        this.persistId = options.persist;
        this.store = new IndexedDBStore();
      } else {
        this.persistId = options.persist.id;
        this.store = options.persist.store;
      }
    }
    this.onPersistError =
      options.onPersistError ?? ((e) => console.warn("[wepi] failed to persist chat snapshot", e));

    const sandbox = options.sandbox ?? new NullSandbox();
    // Only mirror the workspace into real sandboxes — syncing into the
    // NullSandbox would just prepend "bash unavailable" noise to every call.
    const syncFs = sandbox instanceof NullSandbox ? undefined : this.fs;
    const enabled = (name: DefaultToolName) =>
      options.defaultTools === undefined || (options.defaultTools !== false && options.defaultTools.includes(name));
    const extraTools = typeof options.tools === "function" ? options.tools(this.fs) : (options.tools ?? []);
    const tools: AgentTool[] = [
      ...createFileTools(this.fs).filter((t) => enabled(t.name as DefaultToolName)),
      ...(enabled("bash") ? [createBashTool(sandbox, { fs: syncFs, workdir })] : []),
      ...extraTools,
    ];
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt ?? defaultSystemPrompt(workdir),
        model,
        tools,
      },
      streamFn,
      getApiKey,
      convertToLlm,
      // Local engines mark unparseable tool-call JSON with INVALID_TOOL_ARGS
      // (see engine/openai.ts). Tools with required params already fail
      // schema validation on it (the error echoes the raw arguments back to
      // the model); this guard catches the rest — all-optional schemas where
      // `{}` would silently "succeed" — and turns them into corrective error
      // results the model can react to.
      beforeToolCall: async ({ toolCall }) => {
        const args = toolCall.arguments as Record<string, unknown> | undefined;
        const sentinel = args?.[INVALID_TOOL_ARGS];
        if (typeof sentinel !== "string") return undefined;
        const guidance =
          this.invalidToolCallStreak >= MAX_INVALID_TOOL_CALL_STREAK
            ? " Do not call tools again this turn — reply in plain text with what you have so far."
            : " Re-issue the tool call with valid, complete JSON arguments.";
        return { block: true, reason: sentinel + guidance };
      },
    });

    this.agent.subscribe((event) => {
      // Streak of unparseable tool calls (both validation-rejected and
      // guard-blocked paths emit these events); any clean result resets it.
      if (event.type === "tool_execution_start") {
        const args = event.args as Record<string, unknown> | undefined;
        if (typeof args?.[INVALID_TOOL_ARGS] === "string") this.invalidToolCallStreak++;
      } else if (event.type === "tool_execution_end" && !event.isError) {
        this.invalidToolCallStreak = 0;
      } else if (event.type === "agent_end") {
        this.invalidToolCallStreak = 0;
      }

      for (const listener of this.listeners) listener(event);
      if (event.type === "agent_end") this.persistNow();
    });
  }

  /**
   * Load the persisted snapshot, if any. Called by `createChat`; safe to call
   * once on a directly-constructed Chat. No-op without `persist`.
   */
  async restore(): Promise<void> {
    if (!this.store || !this.persistId || this.restored) return;
    this.restored = true;
    const snapshot = await this.store.load(this.persistId);
    if (!snapshot) return;
    for (const [path, content] of Object.entries(snapshot.files)) {
      this.fs.write(path, content); // marked dirty → re-pushed to the sandbox on next bash
    }
    this.agent.state.messages = snapshot.messages;
  }

  /**
   * Send a message; returns a Turn you can stream (`for await`) or await.
   * Throws a WepiError with code "busy" if a turn is already in flight.
   */
  send(message: string, opts: SendOptions = {}): Turn {
    // The Turn settles on agent_end, slightly before the agent finishes
    // settling its listeners — so gate on the Turn (the user-visible contract)
    // and let waitForIdle absorb the residue below.
    if (this.current && !this.current.settled) {
      throw new WepiError(
        "a turn is already in flight — await it, or call abort() first",
        "busy",
      );
    }
    const turn = new Turn(() => this.agent.abort(), opts.onTool);
    this.current = turn;
    const unsub = this.agent.subscribe((event) => turn.handleEvent(event));
    this.agent
      .waitForIdle()
      .then(() => this.agent.prompt(message))
      .catch((err: unknown) => turn.fail(err))
      .finally(() => unsub());
    return turn;
  }

  /** Abort the in-flight turn, if any. */
  abort(): void {
    this.agent.abort();
  }

  /**
   * Observe raw agent events (message/turn/tool lifecycle) across all turns —
   * for custom UIs that need more than text deltas. Returns an unsubscribe fn.
   */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Conversation transcript. */
  get messages(): readonly AgentMessage[] {
    return this.agent.state.messages;
  }

  /** Token/cost accounting across the conversation so far. */
  get metrics(): ChatMetrics {
    let turns = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsd = 0;
    let lastTotal = 0;
    for (const m of this.agent.state.messages) {
      if ((m as { role?: string }).role !== "assistant" || !("usage" in m)) continue;
      const u = (m as { usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } } }).usage;
      turns++;
      tokensIn += u.input + u.cacheRead + u.cacheWrite;
      tokensOut += u.output;
      costUsd += u.cost.total;
      lastTotal = u.totalTokens;
    }
    return {
      turns,
      tokensIn,
      tokensOut,
      costUsd,
      contextPct: this.contextWindow > 0 ? lastTotal / this.contextWindow : 0,
    };
  }

  /** Read the workspace back out, keyed by relative path. */
  files(): Record<string, string> {
    return this.fs.snapshot();
  }

  /**
   * Clear the conversation history and persist the empty transcript. The
   * workspace files survive — resetting frees the model's context without
   * losing what the agent built. (For local engines this is the escape hatch
   * when the context window fills up.)
   */
  reset(): void {
    this.agent.abort();
    this.agent.state.messages = [];
    this.persistNow();
  }

  /** Tear down: abort any in-flight turn and flush a final snapshot. */
  dispose(): void {
    this.agent.abort();
    this.persistNow();
  }

  private persistNow(): void {
    if (!this.store || !this.persistId) return;
    const snapshot: ChatSnapshot = {
      version: 1,
      messages: this.agent.state.messages,
      files: this.fs.snapshot(),
      updatedAt: Date.now(),
    };
    void this.store.save(this.persistId, snapshot).catch(this.onPersistError);
  }
}
