/**
 * Shared core for local in-browser engines that speak the OpenAI
 * chat-completions dialect. `wepi/webllm` (MLC WebLLM) and `wepi/wllama`
 * (llama.cpp compiled to WASM) both stream OpenAI-shaped chunks; this module
 * owns the translation between pi-ai's `Context`/`AssistantMessageEvent` world
 * and that dialect, so each engine module only adapts its engine's transport.
 *
 * Internal — not a package export. The public seams are `wepi/webllm` and
 * `wepi/wllama`.
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
      const completion = await engine.createStream(
        {
          messages: toOpenAIMessages(context, options?.foldSystemIntoUserWhenTools ?? false),
          tools: toOpenAITools(context.tools),
          tool_choice: context.tools?.length ? "auto" : undefined,
          stream: true,
          max_tokens: model.maxTokens,
          temperature: streamOptions?.temperature,
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
            out.push({ type: "toolcall_delta", contentIndex: st.contentIndex, delta: tc.function.arguments, partial: clone(partial) });
          }
        }

        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }

      endText();

      // Finalize tool calls: parse accumulated JSON args and emit toolcall_end.
      for (const st of tools.values()) {
        const args = parseArgs(st.args);
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

function parseArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** pi-ai Context → OpenAI chat.completions `messages`. */
export function toOpenAIMessages(
  context: Context,
  foldSystemIntoUserWhenTools: boolean,
): Record<string, unknown>[] {
  const converted: Record<string, unknown>[] = [];
  for (const message of context.messages) {
    converted.push(...convertMessage(message));
  }

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
export function toOpenAITools(tools?: Tool[]): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
