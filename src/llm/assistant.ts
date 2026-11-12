import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantConfig } from "../config/assistant.ts";
import type { SystemPrompt } from "../prompt/system-prompt.ts";
import { buildRequest, type ChatMessage, type ToolDefinition } from "./request.ts";

type Message = Anthropic.Beta.Messages.BetaMessage;
type ToolResultBlock = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export interface ReplyHandlers {
  /** Кусочки текста по мере генерации, для вывода в реальном времени. */
  readonly onText?: (delta: string) => void;
  /** Модель начала размышлять: текста ещё нет, но работа идёт. */
  readonly onThinking?: () => void;
  /** Основная модель отказала, ответ продолжила запасная. */
  readonly onFallback?: (fromModel: string, toModel: string) => void;
  /** Модель вызвала инструмент CRM (шаг 3). */
  readonly onTool?: (name: string, ok: boolean) => void;
}

/** Инструменты для одного хода: определения для модели и запуск по имени. */
export interface ToolRunner {
  readonly definitions: readonly ToolDefinition[];
  execute(name: string, input: unknown): { readonly content: string; readonly isError: boolean };
}

export interface ReplyOptions {
  /** Отмена запроса к модели, например когда клиент закрыл вкладку. */
  readonly signal?: AbortSignal;
  /** Модель для этого хода (роутер, шаг 6). */
  readonly model?: string;
  /** Быстрый режим для простых вопросов: без размышлений и с низким усилием. */
  readonly fast?: boolean;
  readonly tools?: ToolRunner;
}

export interface ReplyTiming {
  /** От отправки запроса до первого кусочка текста, мс. null, если текста не было. */
  readonly firstTextMs: number | null;
  /** От отправки запроса до полного ответа, мс. */
  readonly totalMs: number;
}

/** Один вызов модели внутри хода: при работе с инструментами их несколько. */
export interface ModelCall {
  readonly model: string;
  readonly requestId: string | null;
  readonly stopReason: string | null;
  readonly startMs: number;
  readonly ms: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface ToolCall {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
}

/** Что ответила модель и во сколько токенов это обошлось. */
export interface ReplySummary {
  readonly text: string;
  /** Последнее сообщение модели в ходе. */
  readonly message: Message;
  readonly stopReason: Message["stop_reason"];
  readonly refusalCategory: string | null;
  /** Какая модель фактически дала ответ. */
  readonly servedBy: string;
  readonly fallbackUsed: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Reply extends ReplySummary {
  /** Идентификатор запроса у Anthropic: по нему ответ находится в их логах. */
  readonly requestId: string | null;
  readonly timing: ReplyTiming;
  /** Все новые сообщения хода по порядку: ответы модели и результаты инструментов. */
  readonly turnMessages?: readonly ChatMessage[];
  readonly calls?: readonly ModelCall[];
  readonly toolCalls?: readonly ToolCall[];
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Сколько раз подряд модель может вызвать инструменты в одном ходе. Последний круг всегда текстом. */
export const MAX_TOOL_ROUNDS = 4;

const sum = (calls: readonly ModelCall[], pick: (call: ModelCall) => number): number =>
  calls.reduce((total, call) => total + pick(call), 0);

/** Ассистент VoroniX.ai: модель + системный промпт + инструменты. */
export class Assistant {
  readonly #client: Anthropic;
  readonly #config: AssistantConfig;
  readonly #system: SystemPrompt | null;

  constructor(client: Anthropic, config: AssistantConfig, system: SystemPrompt | null) {
    this.#client = client;
    this.#config = config;
    this.#system = system;
  }

  get systemPrompt(): SystemPrompt | null {
    return this.#system;
  }

  get config(): AssistantConfig {
    return this.#config;
  }

  async reply(
    history: readonly ChatMessage[],
    handlers: ReplyHandlers = {},
    options: ReplyOptions = {},
  ): Promise<Reply> {
    const started = performance.now();
    const since = (): number => Math.round(performance.now() - started);
    let firstTextMs: number | null = null;
    let fallbackUsed = false;
    let last: Message | null = null;
    const appended: ChatMessage[] = [];
    const calls: ModelCall[] = [];
    const toolCalls: ToolCall[] = [];
    const texts: string[] = [];
    const tools = options.tools;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const callStart = since();
      const request = buildRequest(this.#config, this.#system, [...history, ...appended], {
        ...(options.model === undefined ? {} : { model: options.model }),
        fast: options.fast === true,
        cache: this.#system !== null,
        tools: tools?.definitions ?? [],
        finalRound: round === MAX_TOOL_ROUNDS,
      });
      const stream = this.#client.beta.messages.stream(request, { signal: options.signal ?? null });
      let roundText = false;
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          firstTextMs ??= since();
          if (!roundText && texts.length > 0) {
            handlers.onText?.("\n\n");
          }
          roundText = true;
          handlers.onText?.(event.delta.text);
        } else if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "thinking" || block.type === "redacted_thinking") {
            handlers.onThinking?.();
          } else if (block.type === "fallback") {
            handlers.onFallback?.(block.from.model, block.to.model);
          }
        }
      }
      const message = await stream.finalMessage();
      last = message;
      const summary = summarizeReply(message);
      fallbackUsed ||= summary.fallbackUsed;
      if (summary.text !== "") {
        texts.push(summary.text);
      }
      const usage = message.usage;
      calls.push({
        model: message.model,
        requestId: stream.request_id ?? null,
        stopReason: message.stop_reason,
        startMs: callStart,
        ms: since() - callStart,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      });
      appended.push({ role: "assistant", content: message.content });
      const uses = message.content.flatMap((block) => (block.type === "tool_use" ? [block] : []));
      if (message.stop_reason !== "tool_use" || uses.length === 0 || tools === undefined) {
        break;
      }
      const results: ToolResultBlock[] = [];
      for (const use of uses) {
        const toolStart = performance.now();
        const result = tools.execute(use.name, use.input);
        toolCalls.push({ name: use.name, ok: !result.isError, ms: Math.round(performance.now() - toolStart) });
        handlers.onTool?.(use.name, !result.isError);
        results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
      }
      appended.push({ role: "user", content: results });
    }

    if (last === null) {
      throw new Error("The model returned no message");
    }
    // Ответ оборвался посреди вызова инструмента: такой хвост без результата сломал бы историю.
    const tail = appended.at(-1);
    if (tail !== undefined && tail.role === "assistant" && last.stop_reason !== "tool_use" && last.content.some((block) => block.type === "tool_use")) {
      appended.pop();
    }
    const cacheReadTokens = sum(calls, (call) => call.cacheReadTokens);
    const cacheWriteTokens = sum(calls, (call) => call.cacheWriteTokens);
    return {
      ...summarizeReply(last),
      text: texts.join("\n\n").trim(),
      fallbackUsed,
      inputTokens: sum(calls, (call) => call.inputTokens) + cacheReadTokens + cacheWriteTokens,
      outputTokens: sum(calls, (call) => call.outputTokens),
      requestId: calls.at(-1)?.requestId ?? null,
      timing: { firstTextMs, totalMs: since() },
      turnMessages: appended,
      calls,
      toolCalls,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }
}

export function summarizeReply(message: Message): ReplySummary {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  return {
    text,
    message,
    stopReason: message.stop_reason,
    refusalCategory: message.stop_reason === "refusal" ? (message.stop_details?.category ?? null) : null,
    servedBy: message.model,
    fallbackUsed: message.content.some((block) => block.type === "fallback"),
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

/** Ответ ассистента в формате истории диалога: контент возвращается без изменений. */
export function toHistoryEntry(reply: ReplySummary): ChatMessage {
  return { role: "assistant", content: reply.message.content };
}
