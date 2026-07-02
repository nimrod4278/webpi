/**
 * `wepi/litert` — run **Gemma 4** *locally in the browser* via Google's
 * LiteRT-LM Web API (`@litert-lm/core`), with no API key and no network calls
 * to any provider.
 *
 *   import { createLiteRTProvider } from "wepi/litert";
 *   import { Engine } from "@litert-lm/core"; // demo builds the engine (Vite)
 *   const engine = await Engine.create({
 *     model: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm",
 *     mainExecutorSettings: { maxNumTokens: 8192 },
 *   });
 *   const { provider, modelId } = await createLiteRTProvider({ engine });
 *   const chat = await createChat({ provider, model: modelId }); // keyless
 *
 * Why this exists next to `wepi/wllama` and `wepi/webllm`: those run llama.cpp /
 * MLC and are **text-first**. LiteRT-LM is Google's on-device runtime (the
 * successor to the MediaPipe LLM Inference API) and is the path Google ships
 * Gemma 4 on. Its `Conversation` has **built-in function calling**
 * (`preface.tools` in, `message.tool_calls` out), so the wepi agent drives
 * `bash`/`write` with structured tool calls — no hand-rolled text parser like
 * you'd need to bolt onto llama.cpp for Gemma. Runs on WebGPU from Google's web
 * `.litertlm` bundles (E2B / E4B; a bundle must carry WebGPU artifacts).
 *
 * @litert-lm/core is an OPTIONAL peer dependency: it is only loaded here. Either
 * pass a pre-created `engine` (an `Engine` after `Engine.create` — recommended,
 * and what the demo does so the bundler resolves the package + its WASM), or
 * pass `model` (a `.litertlm` URL or ReadableStream) and let this module
 * lazy-load `@litert-lm/core` and build the engine for you.
 *
 * Two honest scope notes:
 * - Vision: pi-ai's content model carries text + image (`ImageContent`) but has
 *   no audio type, so Gemma 4's audio input is out of reach without extending
 *   pi-ai upstream. We convert image content into LiteRT image items and flip
 *   the conversation's `visionModalityEnabled` when a turn has an image. BUT
 *   `@litert-lm/core` 0.12 is documented as text-in/text-out preview — the image
 *   path is wired to the real types and future-proofed, yet may be a no-op until
 *   a later runtime enables vision. Tools + text work today.
 * - Statelessness: the pi-ai provider seam hands us the whole history each call,
 *   so we build a fresh `Conversation` per turn (system + prior turns as the
 *   `preface`, the final turn as the streamed input). KV-cache reuse across
 *   turns is a later optimization.
 *
 * The engine boundary is intentionally typed `any` (like `WllamaEngine`) so the
 * real `Engine`/`Conversation` is assignable without importing its types, and a
 * fake engine can stand in for the offline `test/litert.test.ts`.
 */

import { createAssistantMessageEventStream, createProvider } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  Model,
  Provider,
  ProviderAuth,
  StreamOptions,
  TextContent,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Structural mirror of the @litert-lm/core shapes we build/read. These match
// `Message` / `MessageContentItem` / `Tool` / `ConversationConfig` from the
// package's own types; the engine methods are `any` so a real `Engine` is
// assignable and a fake is easy to write.
// ---------------------------------------------------------------------------

/** One item in a message's content array (LiteRT `MessageContentItem`). */
export interface LiteRTContentItem {
  type: string;
  text?: string;
  /** Image source (URL or data-URI) — LiteRT reads images from a `path`. */
  path?: string;
  /** Tool result payload, for `role:"tool"` messages. */
  tool_response?: { name?: string; tool_name?: string; response?: Record<string, unknown>; value?: unknown };
}

/** A function call predicted by the model (LiteRT `ToolCall`). */
export interface LiteRTToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments: Record<string, unknown> };
}

/** A LiteRT conversation message (also the streamed chunk shape). */
export interface LiteRTMessage {
  role: string;
  content?: string | LiteRTContentItem[];
  tool_calls?: LiteRTToolCall[];
  /** For `role:"tool"` results — links back to the assistant tool call. */
  tool_call_id?: string;
  /** For `role:"tool"` results — the function name (Gemma's template reads this). */
  name?: string;
}

/**
 * A tool/function declaration in `preface.tools`. Gemma's chat template reads
 * `tool['function']['name' | 'description' | 'parameters']`, so tools MUST be in
 * OpenAI function-wrapper shape — a flat `{name,...}` makes `tool.function`
 * undefined and the template throws "Failed to apply template: undefined value".
 */
export interface LiteRTToolDecl {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

/**
 * The bits of `@litert-lm/core` we call. `any` at the boundary keeps a real
 * `Engine` (whose `createConversation` returns a `Conversation` and whose
 * `sendMessageStreaming` returns a `ReadableStream<Message>`) assignable.
 */
export interface LiteRTEngine {
  createConversation(config?: any): Promise<any> | any;
  delete?(): any;
}

export interface CreateLiteRTProviderOptions {
  /**
   * A pre-created `Engine` (after `Engine.create`). When set, `model` is ignored
   * and `modelId` is only the reported id. Recommended — lets the app own the
   * WASM/model lifecycle (and keeps the bundler happy).
   */
  engine?: LiteRTEngine;
  /** `.litertlm` model source (URL or ReadableStream) — used when this module builds the engine. */
  model?: string | ReadableStream<Uint8Array>;
  /** Model context window in tokens; also passed as LiteRT `maxNumTokens`. Default 8192. */
  contextWindow?: number;
  /** Max output tokens per turn (LiteRT `sessionConfig.maxOutputTokens`). Default 4096. */
  maxTokens?: number;
  /** Reported model id. Default: derived from `model`, else "gemma-4-litert". */
  modelId?: string;
  /** Override the module specifier to import (advanced/testing). Default "@litert-lm/core". */
  moduleSpecifier?: string;
}

const PROVIDER_ID = "litert";

/** Keyless auth: a local engine is always "configured". */
const KEYLESS_AUTH: ProviderAuth = {
  apiKey: {
    name: "litert-lm (local, no key)",
    async resolve() {
      return { auth: {}, source: "local" };
    },
  },
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Build a keyless pi-ai `Provider` backed by a local LiteRT-LM (Gemma 4) engine.
 * Pass the returned `{ provider, modelId }` to `createChat({ provider, model })`.
 */
export async function createLiteRTProvider(
  options: CreateLiteRTProviderOptions,
): Promise<{ provider: Provider; modelId: string; engine: LiteRTEngine }> {
  const modelId = options.modelId ?? defaultModelId(options);
  const engine = options.engine ?? (await loadEngine(options));
  const maxTokens = options.maxTokens ?? 4096;

  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: "",
    reasoning: false,
    // Gemma 4 is natively multimodal; pi-ai's content model reaches text + image.
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? 8192,
    maxTokens,
  };

  const stream = (requestModel: Model<Api>, context: Context, streamOptions?: StreamOptions) =>
    runLiteRTStream(engine, requestModel, context, streamOptions, maxTokens);

  const provider = createProvider({
    id: PROVIDER_ID,
    name: "litert-lm (local)",
    auth: KEYLESS_AUTH,
    models: [model],
    api: { stream, streamSimple: stream },
  });

  return { provider, modelId, engine };
}

function defaultModelId(options: CreateLiteRTProviderOptions): string {
  if (typeof options.model === "string") {
    const base = options.model.split("/").pop();
    if (base) return base.replace(/\.litertlm$/, "");
  }
  return "gemma-4-litert";
}

/** Lazy-load @litert-lm/core (variable specifier keeps it out of the core graph). */
async function loadEngine(options: CreateLiteRTProviderOptions): Promise<LiteRTEngine> {
  if (!options.model) {
    throw new Error(
      "createLiteRTProvider: pass a `model` (.litertlm URL or ReadableStream) or a pre-created `engine`.",
    );
  }
  const specifier = options.moduleSpecifier ?? "@litert-lm/core";
  // Variable specifier: bundler-opaque so @litert-lm/core stays optional and the
  // core SDK typechecks without it installed.
  const mod: any = await import(/* @vite-ignore */ specifier as string);
  const engine = await mod.Engine.create({
    model: options.model,
    mainExecutorSettings: { maxNumTokens: options.contextWindow ?? 8192 },
  });
  return engine as LiteRTEngine;
}

// ---------------------------------------------------------------------------
// One turn: pi-ai Context -> a fresh LiteRT Conversation, stream chunks -> events.
// ---------------------------------------------------------------------------

function runLiteRTStream(
  engine: LiteRTEngine,
  model: Model<Api>,
  context: Context,
  streamOptions: StreamOptions | undefined,
  maxTokens: number,
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

  let conversation: { cancel?(): void } | undefined;

  const abort = (): boolean => {
    if (!signal?.aborted) return false;
    conversation?.cancel?.();
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
      const { preface, input, hasImages } = toLiteRT(context);
      conversation = await engine.createConversation({
        preface: { messages: preface, tools: toLiteRTTools(context.tools) },
        sessionConfig: {
          maxOutputTokens: maxTokens,
          ...(hasImages ? { visionModalityEnabled: true } : {}),
        },
      });

      const stream = (conversation as any).sendMessageStreaming(input) as AsyncIterable<LiteRTMessage>;

      let textIndex = -1;
      let textOpen = false;
      let toolCount = 0;

      const ensureTextEnded = () => {
        if (textOpen && textIndex >= 0) {
          const block = partial.content[textIndex] as TextContent;
          out.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: clone(partial) });
          textOpen = false;
        }
      };

      for await (const chunk of stream) {
        if (abort()) return;

        // Text deltas: streamed chunks carry incremental content pieces.
        const delta = textOf(chunk.content);
        if (delta) {
          if (textIndex < 0) {
            textIndex = partial.content.length;
            partial.content.push({ type: "text", text: "" });
            out.push({ type: "text_start", contentIndex: textIndex, partial: clone(partial) });
            textOpen = true;
          }
          (partial.content[textIndex] as TextContent).text += delta;
          out.push({ type: "text_delta", contentIndex: textIndex, delta, partial: clone(partial) });
        }

        // Built-in function calling: complete calls arrive on `tool_calls`.
        for (const tc of chunk.tool_calls ?? []) {
          ensureTextEnded();
          const contentIndex = partial.content.length;
          const id = `call_${toolCount++}`;
          const toolCall: ToolCall = {
            type: "toolCall",
            id,
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? {},
          };
          partial.content.push(toolCall);
          out.push({ type: "toolcall_start", contentIndex, partial: clone(partial) });
          out.push({ type: "toolcall_end", contentIndex, toolCall, partial: clone(partial) });
        }
      }

      ensureTextEnded();

      const reason: Extract<AssistantMessage["stopReason"], "stop" | "toolUse"> =
        toolCount > 0 ? "toolUse" : "stop";
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

/** Extract text from a LiteRT message `content` (string or item array). */
function textOf(content: string | LiteRTContentItem[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

// ---------------------------------------------------------------------------
// Converters (pi-ai -> LiteRT). Assumptions about early-preview shapes live
// here and are pinned by test/litert.test.ts.
// ---------------------------------------------------------------------------

/**
 * Split the context into the conversation `preface` (system + prior turns) and
 * the final input turn handed to `sendMessageStreaming`. At stream time the last
 * message is always a `user` or `toolResult` turn (the agent is asking for the
 * next assistant message), so it is the natural streamed input.
 */
function toLiteRT(context: Context): { preface: LiteRTMessage[]; input: LiteRTMessage; hasImages: boolean } {
  let hasImages = false;
  const preface: LiteRTMessage[] = [];
  if (context.systemPrompt) {
    preface.push({ role: "system", content: context.systemPrompt });
  }

  const converted = context.messages.map((m) => {
    const msg = convertMessage(m);
    // Array content is only produced for image-bearing turns (see convertContent).
    if (Array.isArray(msg.content) && msg.content.some((c) => c.type === "image")) hasImages = true;
    return msg;
  });

  const input = converted.pop() ?? { role: "user", content: "" };
  preface.push(...converted);
  return { preface, input, hasImages };
}

function convertMessage(message: Message): LiteRTMessage {
  if (message.role === "user") {
    return { role: "user", content: convertContent(message.content) };
  }
  if (message.role === "toolResult") {
    // The template's OpenAI-style tool path reads `role:"tool"` messages with a
    // string `content` and resolves the function name via `tool_call_id` (or the
    // message `name` as fallback), so send a plain-string result.
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.toolName,
      content: textFromParts(message.content),
    };
  }
  // assistant: text (as a plain string) + tool calls
  const text = message.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
  const toolCalls = message.content
    .filter((c): c is ToolCall => c.type === "toolCall")
    // Include `id` so the template can pair this call with its `role:"tool"` result.
    .map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments ?? {} } }));
  const msg: LiteRTMessage = { role: "assistant", content: text };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return msg;
}

/**
 * pi-ai user/tool content -> LiteRT message content. Returns a plain **string**
 * for text-only turns (the shape the LiteRT-LM README streams, and what Gemma's
 * chat template renders as `message.content`), and only an item **array** when
 * an image is present — otherwise the Gemma template's `content` deref hits an
 * undefined value on an array. Image items carry the source in `path`.
 */
function convertContent(content: string | (TextContent | ImageContent)[]): string | LiteRTContentItem[] {
  if (typeof content === "string") return content;
  const hasImage = content.some((c) => c.type === "image");
  if (!hasImage) {
    return content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }
  const items: LiteRTContentItem[] = [];
  for (const c of content) {
    if (c.type === "text") items.push({ type: "text", text: c.text });
    // pi-ai stores base64 in `data` + `mimeType`; a data-URI is a valid source.
    else if (c.type === "image") items.push({ type: "image", path: `data:${c.mimeType};base64,${c.data}` });
  }
  return items;
}

/** Flatten pi-ai text/image content to plain text (for a tool result payload). */
function textFromParts(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/**
 * pi-ai tools -> LiteRT `preface.tools` in OpenAI function-wrapper shape (the
 * template reads `tool.function.{name,description,parameters}`). Fields are
 * defaulted (never undefined) so the template can deref them safely.
 */
function toLiteRTTools(tools?: Tool[]): LiteRTToolDecl[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.parameters ?? { type: "object", properties: {} },
    },
  }));
}
