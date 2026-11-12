import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Role } from "../auth/roles.ts";
import type { ResponseCache } from "../cache/response-cache.ts";
import { BLOCK_THRESHOLD, blockedReply, scanInjection } from "../guard/injection.ts";
import { UnmaskingStream, countRawPii } from "../guard/pii.ts";
import { toHistoryEntry, type Reply, type ReplyHandlers, type ReplyOptions, type ToolRunner } from "../llm/assistant.ts";
import { describeError } from "../llm/errors.ts";
import type { ChatMessage } from "../llm/request.ts";
import { formatDocuments, type KnowledgeBase } from "../rag/knowledge.ts";
import { routeQuestion, type Route } from "../router/router.ts";
import type { ToolRegistry } from "../tools/crm.ts";
import { Trace } from "../trace/trace.ts";
import type { Conversation } from "./conversation.ts";
import { trimHistory } from "./history.ts";
import type { GuardInfo, SourceRef, TurnLog, TurnMeta, TurnOutcome } from "./turn-log.ts";

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

/** Слои ассистента со 2 по 7. Каждый необязателен: без них сервис работает как на шаге 1. */
export interface ChatLayers {
  readonly knowledge?: KnowledgeBase;
  readonly tools?: ToolRegistry;
  readonly cache?: ResponseCache;
  /** Быстрая модель для простых вопросов. Без неё все вопросы идут в основную модель. */
  readonly fastModel?: string;
  readonly guard?: boolean;
  /** Версия промпта и базы знаний: входит в ключ кэша ответов. */
  readonly version?: string;
}

export interface ChatServiceOptions {
  readonly model: string;
  readonly maxInputChars: number;
  readonly maxHistoryMessages: number;
  readonly maxConcurrent: number;
  readonly log: TurnLog;
  readonly layers?: ChatLayers;
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

interface TurnInput {
  readonly id: string;
  readonly conversation: Conversation;
  readonly text: string;
  readonly sessionTag: string;
  readonly role: Role;
  readonly handlers: ReplyHandlers;
  readonly signal: AbortSignal | undefined;
}

/** Блок доступа для вошедшего сотрудника. Его добавляет только сервер после проверки пароля. */
export const ACCESS_MANAGER =
  '<access role="manager">The server verified this person\'s login: VoroniX staff, role manager. Staff tools are allowed.</access>';

/** Отдаёт готовый текст кусочками, как будто он пишется: для кэша и шаблонных ответов. */
function emitText(onText: ((delta: string) => void) | undefined, text: string): void {
  for (const part of text.match(/[\s\S]{1,40}/g) ?? []) {
    onText?.(part);
  }
}

/** Логика диалога: проверки, слои ассистента, история, отказы, отмена и журнал. Не знает про HTTP. */
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
        `Сообщение слишком длинное: максимум ${String(this.#options.maxInputChars)} символов.`,
      );
    }
    return text;
  }

  /** Синхронно проверяет сообщение и занимает диалог: два ответа в одном диалоге одновременно не идут. */
  begin(conversation: Conversation, input: unknown, sessionTag: string, role: Role = "client"): Turn {
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
          return await this.#run({ id, conversation, text, sessionTag, role, handlers, signal });
        } finally {
          release();
        }
      },
    };
  }

  async #run(turn: TurnInput): Promise<TurnResult> {
    const { id, conversation, text, role, handlers, signal } = turn;
    const layers = this.#options.layers ?? {};
    const startedAt = Date.now();
    const trace = new Trace();

    const finish = (result: {
      readonly outcome: TurnOutcome;
      readonly answer: string;
      readonly history: readonly ChatMessage[] | null;
      readonly reply: Reply | null;
      readonly route: Route | null;
      readonly sources: readonly SourceRef[];
      readonly guard: GuardInfo | null;
      readonly cached: boolean;
      readonly servedBy?: string;
      readonly errorMessage?: string | null;
      readonly errorDetail?: string | null;
    }): TurnResult => {
      const { outcome, reply } = result;
      const elapsed = Date.now() - startedAt;
      const meta: TurnMeta = {
        outcome,
        servedBy: reply?.servedBy ?? result.servedBy ?? null,
        fallbackUsed: reply?.fallbackUsed ?? false,
        requestId: reply?.requestId ?? null,
        firstTextMs: reply === null ? elapsed : reply.timing.firstTextMs,
        totalMs: reply?.timing.totalMs ?? elapsed,
        inputTokens: reply?.inputTokens ?? (outcome === "blocked" || result.cached ? 0 : null),
        outputTokens: reply?.outputTokens ?? (outcome === "blocked" || result.cached ? 0 : null),
        cached: result.cached,
        route: result.route === null ? null : { model: result.route.model, tier: result.route.tier, reason: result.route.reason },
        sources: result.sources,
        tools: (reply?.toolCalls ?? []).map((call) => ({ name: call.name, ok: call.ok })),
        guard: result.guard,
        cacheReadTokens: reply?.cacheReadTokens ?? null,
        cacheWriteTokens: reply?.cacheWriteTokens ?? null,
      };
      const visible = conversation.vault.unmask(result.answer);
      if (result.history !== null) {
        conversation.commit(result.history, [
          { role: "user", text },
          { role: "assistant", text: visible, meta },
        ]);
      } else if (outcome === "blocked") {
        conversation.commit(conversation.history, [
          { role: "user", text },
          { role: "assistant", text: visible, meta },
        ]);
      }
      this.#options.log.add({
        ...meta,
        id,
        at: new Date(startedAt).toISOString(),
        session: turn.sessionTag,
        role,
        model: result.route?.model ?? this.#options.model,
        stopReason: reply?.stopReason ?? null,
        inputChars: text.length,
        outputChars: visible.length,
        error: result.errorDetail ?? null,
        trace: trace.spans,
      });
      return { id, outcome, meta, text: visible, errorMessage: result.errorMessage ?? null };
    };

    // Шаг 5, защита: явную инъекцию останавливаем до модели, личные данные заменяем метками.
    let guard: GuardInfo | null = null;
    let modelText = text;
    if (layers.guard === true) {
      const done = trace.begin("guard");
      const scan = scanInjection(text);
      const masked = conversation.vault.mask(text);
      modelText = masked.text;
      guard = { injection: scan.score, signals: scan.signals, pii: masked.total, blocked: scan.score >= BLOCK_THRESHOLD };
      done({ injection: scan.score, signals: scan.signals.join(",") || null, pii: masked.total, blocked: guard.blocked });
      if (guard.blocked) {
        const answer = blockedReply(text);
        emitText(handlers.onText, answer);
        return finish({ outcome: "blocked", answer, history: null, reply: null, route: null, sources: [], guard, cached: false });
      }
    }

    // Шаг 6, кэш частых вопросов: только первый вопрос диалога, без личных данных и подозрений.
    const cache = layers.cache;
    let cacheKey: string | null = null;
    if (cache !== undefined && conversation.history.length === 0 && role === "client" && (guard === null || (guard.pii === 0 && guard.injection === 0))) {
      const done = trace.begin("cache");
      cacheKey = cache.key(modelText, layers.version ?? "");
      const hit = cache.get(cacheKey);
      done({ hit: hit !== undefined });
      if (hit !== undefined) {
        emitText(handlers.onText, hit.text);
        const history: ChatMessage[] = [
          { role: "user", content: modelText },
          { role: "assistant", content: hit.text },
        ];
        return finish({ outcome: "answered", answer: hit.text, history, reply: null, route: null, sources: hit.sources, guard, cached: true, servedBy: hit.servedBy });
      }
    }

    // Шаг 4: роль подтверждает сервер. Отдельный блок перед вопросом; слова человека о себе роль не меняют.
    const blocks: { type: "text"; text: string }[] = [];
    if (role === "manager") {
      blocks.push({ type: "text", text: ACCESS_MANAGER });
    }

    // Шаг 2, RAG: находим разделы базы знаний и кладём их рядом с вопросом.
    let sources: SourceRef[] = [];
    let topScore: number | null = null;
    if (layers.knowledge !== undefined) {
      const done = trace.begin("rag");
      const hits = layers.knowledge.search(modelText);
      topScore = hits[0]?.score ?? 0;
      sources = hits.map((hit) => ({ id: hit.chunk.id, title: hit.chunk.title }));
      done({ hits: hits.length, top: topScore, ids: sources.map((source) => source.id).join(",") || null });
      if (hits.length > 0) {
        blocks.push({ type: "text", text: formatDocuments(hits) });
      }
    }
    const content: ChatMessage["content"] = blocks.length === 0 ? modelText : [...blocks, { type: "text", text: modelText }];

    // Шаг 6, роутер: простое в быструю модель, остальное в основную.
    let route: Route | null = null;
    if (layers.fastModel !== undefined) {
      route = routeQuestion(modelText, { role, topScore, mainModel: this.#options.model, fastModel: layers.fastModel });
      trace.add("router", trace.now(), 0, { model: route.model, tier: route.tier, reason: route.reason });
    }

    const { messages } = trimHistory([...conversation.history, { role: "user", content }], this.#options.maxHistoryMessages);
    if (layers.guard === true) {
      const outgoing = messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content));
      trace.add("pii-check", trace.now(), 0, { rawPiiSentToModel: countRawPii(outgoing.join("\n")) });
    }

    // Шаг 3, инструменты CRM: набор зависит от роли, права проверяет сервер.
    const registry = layers.tools;
    const runner: ToolRunner | undefined =
      registry === undefined
        ? undefined
        : {
            definitions: registry.definitions(role),
            execute: (name, input) => {
              const done = trace.begin(`tool:${name}`);
              const result = registry.execute(name, input, {
                role,
                unmask: (value) => conversation.vault.unmask(value),
                now: Date.now(),
              });
              done({ ok: result.ok, error: result.ok ? null : result.error });
              return { content: JSON.stringify(result.ok ? result.data : { error: result.error }), isError: !result.ok };
            },
          };

    const output = new UnmaskingStream(
      (delta) => handlers.onText?.(delta),
      (value) => conversation.vault.unmask(value),
    );
    const options: ReplyOptions = {
      ...(signal === undefined ? {} : { signal }),
      ...(route === null ? {} : { model: route.model, fast: route.tier === "fast" }),
      ...(runner === undefined ? {} : { tools: runner }),
    };
    const llmStart = trace.now();
    let reply: Reply | null = null;
    let outcome: TurnOutcome;
    let errorMessage: string | null = null;
    let errorDetail: string | null = null;
    try {
      reply = await this.#engine.reply(messages, { ...handlers, onText: (delta) => { output.write(delta); } }, options);
      output.flush();
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

    // Шаг 7, трейс: каждый вызов модели отдельным шагом, со временем, токенами и кэшем.
    if (reply !== null) {
      const calls = reply.calls ?? [];
      if (calls.length === 0) {
        trace.add("llm", llmStart, reply.timing.totalMs, { model: reply.servedBy, in: reply.inputTokens, out: reply.outputTokens, requestId: reply.requestId });
      }
      for (const call of calls) {
        trace.add("llm", llmStart + call.startMs, call.ms, {
          model: call.model,
          stop: call.stopReason,
          in: call.inputTokens,
          out: call.outputTokens,
          cacheRead: call.cacheReadTokens,
          cacheWrite: call.cacheWriteTokens,
          requestId: call.requestId,
        });
      }
    }

    const saved = outcome === "answered" || outcome === "truncated" ? reply : null;
    if (saved !== null && cache !== undefined && cacheKey !== null && outcome === "answered" && (saved.toolCalls ?? []).length === 0) {
      cache.set(cacheKey, { text: saved.text, servedBy: saved.servedBy, sources });
    }
    return finish({
      outcome,
      answer: reply?.text ?? "",
      history: saved === null ? null : [...messages, ...(saved.turnMessages ?? [toHistoryEntry(saved)])],
      reply,
      route,
      sources,
      guard,
      cached: false,
      errorMessage,
      errorDetail,
    });
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
