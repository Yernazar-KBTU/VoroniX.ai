import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantConfig } from "../config/assistant.ts";
import type { SystemPrompt } from "../prompt/system-prompt.ts";
import { buildRequest, type ChatMessage } from "./request.ts";

type Message = Anthropic.Beta.Messages.BetaMessage;

export interface ReplyHandlers {
  /** Кусочки текста по мере генерации, для вывода в реальном времени. */
  readonly onText?: (delta: string) => void;
  /** Модель начала размышлять: текста ещё нет, но работа идёт. */
  readonly onThinking?: () => void;
  /** Основная модель отказала, ответ продолжила запасная. */
  readonly onFallback?: (fromModel: string, toModel: string) => void;
}

export interface ReplyOptions {
  /** Отмена запроса к модели, например когда клиент закрыл вкладку. */
  readonly signal?: AbortSignal;
}

export interface ReplyTiming {
  /** От отправки запроса до первого кусочка текста, мс. null, если текста не было. */
  readonly firstTextMs: number | null;
  /** От отправки запроса до полного ответа, мс. */
  readonly totalMs: number;
}

/** Что ответила модель и во сколько токенов это обошлось. */
export interface ReplySummary {
  readonly text: string;
  /** Полное сообщение модели: его целиком возвращаем в историю диалога. */
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
}

/** Ассистент VoroniX.ai: модель + системный промпт. */
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
    let firstTextAt: number | null = null;
    const stream = this.#client.beta.messages.stream(buildRequest(this.#config, this.#system, history), {
      signal: options.signal ?? null,
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        firstTextAt ??= performance.now();
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
    return {
      ...summarizeReply(message),
      requestId: stream.request_id ?? null,
      timing: {
        firstTextMs: firstTextAt === null ? null : Math.round(firstTextAt - started),
        totalMs: Math.round(performance.now() - started),
      },
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
