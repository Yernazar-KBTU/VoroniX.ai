import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantConfig } from "../config/assistant.ts";
import type { SystemPrompt } from "../prompt/system-prompt.ts";
import { buildRequest, type ChatMessage } from "./request.ts";

type Message = Anthropic.Beta.Messages.BetaMessage;

export interface ReplyHandlers {
  /** Кусочки текста по мере генерации, для вывода в реальном времени. */
  readonly onText?: (delta: string) => void;
  /** Основная модель отказала, ответ продолжила запасная. */
  readonly onFallback?: (fromModel: string, toModel: string) => void;
}

export interface Reply {
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

  async reply(history: readonly ChatMessage[], handlers: ReplyHandlers = {}): Promise<Reply> {
    const stream = this.#client.beta.messages.stream(buildRequest(this.#config, this.#system, history));
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        handlers.onText?.(event.delta.text);
      } else if (event.type === "content_block_start" && event.content_block.type === "fallback") {
        handlers.onFallback?.(event.content_block.from.model, event.content_block.to.model);
      }
    }
    return summarizeReply(await stream.finalMessage());
  }
}

export function summarizeReply(message: Message): Reply {
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
export function toHistoryEntry(reply: Reply): ChatMessage {
  return { role: "assistant", content: reply.message.content };
}
