/**
 * `LocalChatEngine` — the seam for local in-browser engines that speak the
 * OpenAI chat-completions dialect. `@wepi/sdk/webllm` (MLC WebLLM) and `@wepi/sdk/wllama`
 * (llama.cpp compiled to WASM) both stream OpenAI-shaped chunks; this module
 * owns the translation between pi-ai's `Context`/`AssistantMessageEvent` world
 * and that dialect, so an engine adapter only implements `createStream` (and
 * optionally `interrupt`) over its runtime's transport — ~100 lines each.
 *
 * `./litert.ts` deliberately bypasses this seam: MediaPipe emits structured
 * tool calls (no JSON-in-text to parse), so it implements pi-ai's `Provider`
 * directly instead.
 *
 * Reached through the engine entrypoints (`@wepi/sdk/webllm`, `@wepi/sdk/wllama`); not a
 * package export itself.
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  StreamOptions,
  TextContent,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";

/** One streamed chunk in the OpenAI chat-completions shape. */
export interface OpenAIChatChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

/** The request `runLocalStream` builds. Engine adapters add transport-specific extras. */
export interface OpenAIChatRequest {
  messages: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  tool_choice?: "auto";
  stream: true;
  max_tokens?: number;
  temperature?: number;
}

/**
 * What an engine module must provide: start one streamed completion, and
 * (optionally) a way to interrupt generation. Adapters that accept an
 * AbortSignal natively (wllama) wire `signal` into the request instead.
 */
export interface LocalChatEngine {
  createStream(
    request: OpenAIChatRequest,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<OpenAIChatChunk>>;
  interrupt?(): void | Promise<void>;
}

export interface RunLocalStreamOptions {
  /**
   * Fold the system prompt into the first user turn when tools are present.
   * WebLLM's function-calling modes (e.g. Hermes-2-Pro) inject their own system
   * prompt and REJECT a custom `system` message when `tools` are set. llama.cpp
   * (wllama) applies the model's chat template and accepts both, so it keeps a
   * real `system` role.
   */
  foldSystemIntoUserWhenTools?: boolean;
  /** Tune the context-budget fitting (see `ContextBudget`). */
  contextBudget?: Partial<ContextBudget>;
}

/**
 * Budget for `fitToContextBudget`. Local engines have a HARD context window
 * (llama.cpp aborts the WASM runtime past `n_ctx`; WebLLM errors), so the
 * history must be made to fit before every request — there is no server to
 * truncate for us.
 */
export interface ContextBudget {
  /** Model context window, tokens. */
  contextWindow: number;
  /** Output reservation, tokens (the engine's max_tokens). */
  maxTokens: number;
  /** Crude chars→tokens ratio for budgeting. Default 4. */
  charsPerToken?: number;
  /** Tokens held back for chat-template + tool-schema overhead. Default 512. */
  reserveTokens?: number;
  /**
   * Per-message cap on `role:"tool"` content, chars. One 30KB bash result is
   * ~7.5k tokens — nearly a whole 8k window — so round-dropping alone can't
   * save an over-long tool output. Default 8000 (~2k tokens).
   */
  maxToolResultChars?: number;
  /** Chars already spoken for outside `messages` (tools JSON, system prompt). */
  overheadChars?: number;
}

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Drive one turn against the engine, translating chunks → pi-ai events. */
export function runLocalStream(
  engine: LocalChatEngine,
  model: Model<Api>,
  context: Context,
  streamOptions?: StreamOptions,
  options?: RunLocalStreamOptions,
) {
  const out = createAssistantMessageEventStream();
  const signal = streamOptions?.signal;

  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...ZERO_USAGE },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  const abort = (): boolean => {
    if (!signal?.aborted) return false;
    void engine.interrupt?.();
    const aborted: AssistantMessage = {
      ...partial,
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      timestamp: Date.now(),
    };
    out.push({ type: "error", reason: "aborted", error: aborted });
    out.end(aborted);
    return true;
  };

  void (async () => {
    if (abort()) return;
    out.push({ type: "start", partial: clone(partial) });
    try {
      const openAITools = toOpenAITools(context.tools);
      const toolsChars = openAITools ? JSON.stringify(openAITools).length : 0;
      const systemChars = context.systemPrompt?.length ?? 0;
      // Fit BEFORE the system prompt is attached/folded, so dropping the oldest
      // rounds can never lose it (WebLLM folds it into the first user turn).
      const fitted = fitToContextBudget(convertMessages(context), {
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        overheadChars: toolsChars + systemChars,
        ...options?.contextBudget,
      });
      const messages = applySystemPrompt(fitted, context, options?.foldSystemIntoUserWhenTools ?? false);
      const sentChars = JSON.stringify(messages).length + toolsChars;
      let generatedChars = 0;

      const completion = await engine.createStream(
        {
          messages,
          tools: openAITools,
          tool_choice: context.tools?.length ? "auto" : undefined,
          stream: true,
          max_tokens: model.maxTokens,
          // Small local models need a low temperature to produce parseable
          // tool-call JSON; explicit caller values still win.
          temperature: streamOptions?.temperature ?? (context.tools?.length ? 0.2 : undefined),
        },
        signal,
      );

      let textIndex = -1; // content index of the (single) text block, or -1
      let textOpen = false;
      let finishReason: string | null | undefined;
      let usage: OpenAIChatChunk["usage"];
      // tool_call delta index -> our accumulator
      const tools = new Map<number, { contentIndex: number; id: string; name: string; args: string }>();

      const endText = () => {
        if (textOpen && textIndex >= 0) {
          const block = partial.content[textIndex] as TextContent;
          out.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: clone(partial) });
          textOpen = false;
        }
      };

      for await (const chunk of completion) {
        if (abort()) return;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;

        if (delta?.content) {
          if (textIndex < 0) {
            textIndex = partial.content.length;
            partial.content.push({ type: "text", text: "" });
            out.push({ type: "text_start", contentIndex: textIndex, partial: clone(partial) });
            textOpen = true;
          }
          (partial.content[textIndex] as TextContent).text += delta.content;
          generatedChars += delta.content.length;
          out.push({ type: "text_delta", contentIndex: textIndex, delta: delta.content, partial: clone(partial) });
        }

        for (const tc of delta?.tool_calls ?? []) {
          // A tool call implies text (if any) is done streaming.
          endText();
          let st = tools.get(tc.index);
          if (!st) {
            const contentIndex = partial.content.length;
            st = { contentIndex, id: tc.id ?? `call_${tc.index}`, name: tc.function?.name ?? "", args: "" };
            tools.set(tc.index, st);
            partial.content.push({ type: "toolCall", id: st.id, name: st.name, arguments: {} });
            out.push({ type: "toolcall_start", contentIndex, partial: clone(partial) });
          }
          if (tc.id) st.id = tc.id;
          if (tc.function?.name) {
            st.name = tc.function.name;
            (partial.content[st.contentIndex] as ToolCall).name = st.name;
            (partial.content[st.contentIndex] as ToolCall).id = st.id;
          }
          if (tc.function?.arguments) {
            st.args += tc.function.arguments;
            generatedChars += tc.function.arguments.length;
            out.push({ type: "toolcall_delta", contentIndex: st.contentIndex, delta: tc.function.arguments, partial: clone(partial) });
          }
        }

        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }

      endText();

      // Finalize tool calls: parse accumulated JSON args and emit toolcall_end.
      for (const st of tools.values()) {
        const args = parseToolArguments(st.args, finishReason === "length");
        const toolCall: ToolCall = { type: "toolCall", id: st.id, name: st.name, arguments: args };
        partial.content[st.contentIndex] = toolCall;
        out.push({ type: "toolcall_end", contentIndex: st.contentIndex, toolCall, partial: clone(partial) });
      }

      if (usage) {
        const input = usage.prompt_tokens ?? 0;
        const output = usage.completion_tokens ?? 0;
        partial.usage = {
          ...ZERO_USAGE,
          input,
          output,
          totalTokens: usage.total_tokens ?? input + output,
        };
      } else {
        // wllama never emits a usage chunk; estimate at chars/4 so downstream
        // context accounting (Chat.metrics.contextPct) works for local engines.
        const charsPerToken = options?.contextBudget?.charsPerToken ?? 4;
        const input = Math.ceil(sentChars / charsPerToken);
        const output = Math.ceil(generatedChars / charsPerToken);
        partial.usage = { ...ZERO_USAGE, input, output, totalTokens: input + output };
      }

      const reason: Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> =
        tools.size > 0 || finishReason === "tool_calls"
          ? "toolUse"
          : finishReason === "length"
            ? "length"
            : "stop";
      partial.stopReason = reason;
      partial.timestamp = Date.now();

      out.push({ type: "done", reason, message: clone(partial) });
      out.end(clone(partial));
    } catch (error) {
      if (abort()) return;
      const message: AssistantMessage = {
        ...partial,
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      out.push({ type: "error", reason: "error", error: message });
      out.end(message);
    }
  })();

  return out;
}

function clone(message: AssistantMessage): AssistantMessage {
  return { ...message, content: message.content.map((c) => ({ ...c })) };
}

/**
 * Marker key for tool calls whose arguments could not be parsed as JSON. Local
 * engines emit prompt-templated tool calls, and small models routinely produce
 * malformed or length-truncated JSON. Instead of silently passing `{}` (which
 * either executes the tool with empty args or produces a misleading validation
 * error), the sentinel carries a description of what went wrong:
 * - tools with required params fail pi-ai's schema validation, whose error
 *   echoes these arguments back to the model;
 * - all-optional tools are blocked by Chat's `beforeToolCall` guard.
 * Either way the agent loop delivers the message as an error tool result and
 * the model gets a chance to re-issue the call.
 */
export const INVALID_TOOL_ARGS = "__wepi_invalid_tool_args";

/**
 * Parse accumulated tool-call arguments. Attempts bounded repairs (Markdown
 * fences, surrounding prose, unclosed strings/brackets on length truncation)
 * before giving up with an `INVALID_TOOL_ARGS` sentinel object.
 * Exported for tests.
 */
export function parseToolArguments(raw: string, lengthTruncated: boolean): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  for (const candidate of repairCandidates(trimmed, lengthTruncated)) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next repair
    }
  }

  console.warn("[wepi] could not parse tool-call arguments as JSON", {
    lengthTruncated,
    raw: trimmed.slice(0, 400),
  });
  const hint = lengthTruncated
    ? " — the output hit the max_tokens limit and was cut off mid-call; produce SHORTER" +
      " arguments (e.g. a smaller file, or several smaller edits instead of one large write)"
    : "";
  return {
    [INVALID_TOOL_ARGS]:
      `Tool call arguments were not valid JSON${hint}. ` +
      `Raw arguments received (first 400 chars): ${trimmed.slice(0, 400)}`,
  };
}

/** Progressively repaired parse candidates, cheapest first. */
function* repairCandidates(trimmed: string, lengthTruncated: boolean): Generator<string> {
  yield trimmed;

  // Strip a Markdown code fence (```json ... ```), a common small-model habit.
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*(?:```)?$/.exec(trimmed);
  if (fenced?.[1]) yield fenced[1];

  // Slice from the first "{" to the last "}" to drop surrounding prose.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) yield trimmed.slice(start, end + 1);

  // Truncated output: close an unterminated string and any open brackets.
  if (lengthTruncated && start >= 0) yield closeTruncatedJson(trimmed.slice(start));
}

/** Best-effort close of a JSON prefix cut off mid-generation. */
function closeTruncatedJson(prefix: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of prefix) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let repaired = prefix;
  // A dangling escape can't be completed meaningfully; drop it before closing.
  if (inString && escaped) repaired = repaired.slice(0, -1);
  if (inString) repaired += '"';
  // Trim a trailing comma or colon that would invalidate the closing brackets.
  repaired = repaired.replace(/[,:]\s*$/, "");
  while (stack.length) repaired += stack.pop();
  return repaired;
}

/** Context.messages → OpenAI messages, without the system prompt. */
function convertMessages(context: Context): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = [];
  for (const message of context.messages) {
    converted.push(...convertMessage(message));
  }
  return converted;
}

/**
 * Attach the system prompt — as a real `system` message, or folded into the
 * first user turn (see `RunLocalStreamOptions.foldSystemIntoUserWhenTools`).
 * Runs AFTER budget fitting so truncation can never drop the system prompt.
 */
function applySystemPrompt(
  converted: Record<string, unknown>[],
  context: Context,
  foldSystemIntoUserWhenTools: boolean,
): Record<string, unknown>[] {
  const system = context.systemPrompt;
  if (system && context.tools?.length && foldSystemIntoUserWhenTools) {
    const firstUser = converted.find((m) => m.role === "user");
    if (firstUser) {
      firstUser.content = `${system}\n\n${String(firstUser.content ?? "")}`;
    } else {
      converted.unshift({ role: "user", content: system });
    }
    return converted;
  }

  const messages: Record<string, unknown>[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push(...converted);
  return messages;
}

const TRUNCATION_BRIDGE =
  "[Earlier conversation was truncated to fit the on-device model's context window.]";

/**
 * Trim OpenAI-shaped `messages` (no system message — see `applySystemPrompt`)
 * to fit `(contextWindow − maxTokens − reserve)` tokens:
 *
 * 1. Clamp oversized `role:"tool"` contents (head + tail around a marker).
 * 2. Drop the oldest *rounds* until the rest fits. A round starts at each
 *    `user` message and spans the assistant/tool messages that follow it, so a
 *    `tool` message is never orphaned from the assistant `tool_calls` that
 *    produced it — chat templates hard-fail on that.
 * 3. The newest round is always kept, and a bridge user message marks the cut.
 *
 * Exported for tests; called by `runLocalStream` on every request.
 */
export function fitToContextBudget(
  messages: Record<string, unknown>[],
  budget: ContextBudget,
): Record<string, unknown>[] {
  const charsPerToken = budget.charsPerToken ?? 4;
  const reserveTokens = budget.reserveTokens ?? 512;
  const maxToolResultChars = budget.maxToolResultChars ?? 8000;
  const inputTokens = Math.max(0, budget.contextWindow - budget.maxTokens - reserveTokens);
  const budgetChars = inputTokens * charsPerToken - (budget.overheadChars ?? 0);

  const clamped = messages.map((m) => clampToolResult(m, maxToolResultChars));
  if (totalChars(clamped) <= budgetChars) return clamped;

  // Partition into rounds; any leading non-user messages join the first round.
  const rounds: Record<string, unknown>[][] = [];
  let current: Record<string, unknown>[] | undefined;
  for (const m of clamped) {
    if (m.role === "user" || !current) {
      current = [m];
      rounds.push(current);
    } else {
      current.push(m);
    }
  }

  const kept: Record<string, unknown>[][] = [];
  let used = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = rounds[i]!;
    const size = totalChars(round);
    if (kept.length > 0 && used + size > budgetChars) break;
    kept.unshift(round);
    used += size;
  }

  if (kept.length === rounds.length) return clamped;
  return [{ role: "user", content: TRUNCATION_BRIDGE }, ...kept.flat()];
}

function totalChars(messages: Record<string, unknown>[]): number {
  let sum = 0;
  for (const m of messages) sum += JSON.stringify(m).length;
  return sum;
}

function clampToolResult(
  message: Record<string, unknown>,
  maxChars: number,
): Record<string, unknown> {
  if (message.role !== "tool" || typeof message.content !== "string") return message;
  const content = message.content;
  if (content.length <= maxChars) return message;
  const marker = "\n…[tool output truncated to fit the on-device model's context]…\n";
  const head = Math.floor((maxChars - marker.length) * 0.75);
  const tail = maxChars - marker.length - head;
  return { ...message, content: content.slice(0, head) + marker + content.slice(-tail) };
}

function convertMessage(message: Message): Record<string, unknown>[] {
  if (message.role === "user") {
    return [{ role: "user", content: textOf(message.content) }];
  }
  if (message.role === "toolResult") {
    return [{ role: "tool", tool_call_id: message.toolCallId, content: textOf(message.content) }];
  }
  // assistant
  const text = message.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
  const toolCalls = message.content
    .filter((c): c is ToolCall => c.type === "toolCall")
    .map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
    }));
  const out: Record<string, unknown> = { role: "assistant", content: text };
  if (toolCalls.length) out.tool_calls = toolCalls;
  return [out];
}

/** Flatten mixed text/image content to plain text (local engines are text-first here). */
function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

/** pi-ai tools (typebox JSON-schema params) → OpenAI `tools`. */
function toOpenAITools(tools?: Tool[]): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
