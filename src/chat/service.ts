import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { toHistoryEntry, type Reply, type ReplyHandlers, type ReplyOptions } from "../llm/assistant.ts";
import { describeError } from "../llm/errors.ts";
import type { ChatMessage } from "../llm/request.ts";
import type { Conversation } from "./conversation.ts";
import { trimHistory } from "./history.ts";
import type { TurnLog, TurnMeta, TurnOutcome } from "./turn-log.ts";

/** То, что умеет отвечать: настоящий Assistant или подделка в тестах. */
export interface ChatEngine {
  reply(history: readonly ChatMessage[], handlers?: ReplyHandlers, options?: ReplyOptions): Promise<Reply>;
}

export type ChatErrorCode = "empty" | "too_long" | "bad_input" | "busy" | "overloaded";

/** Ошибка до обращения к модели: сообщение отклонено, деньги не потрачены. */
export class ChatError extends Error {
  readonly code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.name = "ChatError";
    this.code = code;
  }
}

export interface ChatServiceOptions {
  readonly model: string;
  readonly maxInputChars: number;
  readonly maxHistoryMessages: number;
  readonly maxConcurrent: number;
  readonly log: TurnLog;
}

export interface TurnResult {
  readonly id: string;
  readonly outcome: TurnOutcome;
  readonly meta: TurnMeta;
  readonly text: string;
  /** Для outcome = failed: текст для клиента, без технических подробностей. */
  readonly errorMessage: string | null;
}

/** Ход диалога, который уже прошёл проверки и занял диалог. */
export interface Turn {
  readonly id: string;
  run(handlers?: ReplyHandlers, signal?: AbortSignal): Promise<TurnResult>;
  /** Освобождает диалог, если run так и не был вызван. Повторный вызов безопасен. */
  release(): void;
}

/** Логика диалога: проверки, история, отказы, отмена и журнал. Не знает про HTTP. */
export class ChatService {
  readonly #engine: ChatEngine;
  readonly #options: ChatServiceOptions;
  #active = 0;

  constructor(engine: ChatEngine, options: ChatServiceOptions) {
    this.#engine = engine;
    this.#options = options;
  }

  get activeTurns(): number {
    return this.#active;
  }

  get log(): TurnLog {
    return this.#options.log;
  }

  validate(input: unknown): string {
    if (typeof input !== "string") {
      throw new ChatError("bad_input", "Сообщение должно быть текстом.");
    }
    const text = input.trim();
    if (text === "") {
      throw new ChatError("empty", "Напишите сообщение.");
    }
    if (text.length > this.#options.maxInputChars) {
      throw new ChatError(
        "too_long",
        `Сообщение слишком длинное: максимум ${this.#options.maxInputChars} символов.`,
      );
    }
    return text;
  }

  /** Синхронно проверяет сообщение и занимает диалог: два ответа в одном диалоге одновременно не идут. */
  begin(conversation: Conversation, input: unknown, sessionTag: string): Turn {
    const text = this.validate(input);
    if (this.#active >= this.#options.maxConcurrent) {
      throw new ChatError("overloaded", "Сейчас очень много обращений. Повторите через минуту.");
    }
    if (!conversation.tryLock()) {
      throw new ChatError("busy", "Дождитесь окончания предыдущего ответа.");
    }
    this.#active += 1;
    const id = randomUUID();
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      conversation.unlock();
      this.#active -= 1;
    };
    return {
      id,
      release,
      run: async (handlers = {}, signal) => {
        try {
          return await this.#run({ id, conversation, text, sessionTag, handlers, signal });
        } finally {
          release();
        }
      },
    };
  }

  async #run(turn: {
    readonly id: string;
    readonly conversation: Conversation;
    readonly text: string;
    readonly sessionTag: string;
    readonly handlers: ReplyHandlers;
    readonly signal: AbortSignal | undefined;
  }): Promise<TurnResult> {
    const { id, conversation, text, handlers, signal } = turn;
    const startedAt = Date.now();
    const userMessage: ChatMessage = { role: "user", content: text };
    const { messages } = trimHistory([...conversation.history, userMessage], this.#options.maxHistoryMessages);

    let reply: Reply | null = null;
    let outcome: TurnOutcome;
    let errorMessage: string | null = null;
    let errorDetail: string | null = null;
    try {
      reply = await this.#engine.reply(messages, handlers, signal === undefined ? {} : { signal });
      if (reply.stopReason === "refusal") {
        outcome = "refused";
      } else if (reply.text === "") {
        outcome = "failed";
        errorMessage = "Модель вернула пустой ответ. Попробуйте переформулировать вопрос.";
        errorDetail = `empty reply, stop_reason=${reply.stopReason ?? "null"}`;
      } else {
        outcome = reply.stopReason === "max_tokens" ? "truncated" : "answered";
      }
    } catch (error) {
      if (signal?.aborted === true || error instanceof Anthropic.APIUserAbortError) {
        outcome = "cancelled";
      } else {
        outcome = "failed";
        errorMessage = publicErrorMessage(error);
        errorDetail = describeError(error);
      }
    }

    const meta: TurnMeta = {
      outcome,
      servedBy: reply?.servedBy ?? null,
      fallbackUsed: reply?.fallbackUsed ?? false,
      requestId: reply?.requestId ?? null,
      firstTextMs: reply?.timing.firstTextMs ?? null,
      totalMs: reply?.timing.totalMs ?? Date.now() - startedAt,
      inputTokens: reply?.inputTokens ?? null,
      outputTokens: reply?.outputTokens ?? null,
    };
    if (reply !== null && (outcome === "answered" || outcome === "truncated")) {
      conversation.commit(
        [...messages, toHistoryEntry(reply)],
        [
          { role: "user", text },
          { role: "assistant", text: reply.text, meta },
        ],
      );
    }
    this.#options.log.add({
      ...meta,
      id,
      at: new Date(startedAt).toISOString(),
      session: turn.sessionTag,
      model: this.#options.model,
      stopReason: reply?.stopReason ?? null,
      inputChars: text.length,
      outputChars: reply?.text.length ?? 0,
      error: errorDetail,
    });
    return { id, outcome, meta, text: reply?.text ?? "", errorMessage };
  }
}

/** Клиенту не показываем ключи, статусы и внутренние подробности: они уходят в журнал консоли. */
function publicErrorMessage(error: unknown): string {
  if (
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  ) {
    return "Сервис ответов сейчас перегружен или недоступен. Попробуйте ещё раз через минуту.";
  }
  return "Не получилось получить ответ. Попробуйте ещё раз.";
}
