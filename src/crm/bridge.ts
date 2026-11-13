import { createHash, randomUUID } from "node:crypto";
import type { GuardInfo, RouteInfo, TurnLog, TurnOutcome } from "../chat/turn-log.ts";
import type { ChatEngine } from "../chat/service.ts";
import { BLOCK_THRESHOLD, scanInjection } from "../guard/injection.ts";
import { PiiVault } from "../guard/pii.ts";
import type { ToolResult, ToolRunner } from "../llm/assistant.ts";
import type { ChatMessage, ToolDefinition } from "../llm/request.ts";
import type { SystemPrompt } from "../prompt/system-prompt.ts";
import { routeQuestion } from "../router/router.ts";
import { Trace } from "../trace/trace.ts";

/**
 * VoroniX.ai как третий ИИ в CRM VoroniX. CRM присылает свой системный промпт с данными бизнеса,
 * переписку и описания своих инструментов. VoroniX.ai пропускает всё через свои слои (защита,
 * скрытие личных данных, роутер моделей, трейсы), а инструменты выполняет сама CRM: модель просит
 * инструмент, ход замирает, CRM выполняет его у себя и присылает результат. Поэтому записи
 * попадают в настоящий календарь CRM.
 */

export interface CrmTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface CrmTurnInput {
  readonly conversationId: string;
  readonly system: string;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly tools: readonly CrmTool[];
}

export interface CrmUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export type CrmEvent =
  | { readonly status: "tool"; readonly turnId: string; readonly call: { readonly id: string; readonly name: string; readonly input: unknown } }
  | {
      readonly status: "done";
      readonly turnId: string;
      readonly outcome: TurnOutcome;
      readonly text: string;
      readonly model: string | null;
      readonly route: RouteInfo | null;
      readonly guard: GuardInfo;
      readonly usage: CrmUsage;
    }
  | { readonly status: "failed"; readonly turnId: string; readonly error: string };

export class CrmInputError extends Error {}

const LIMITS = { systemChars: 60_000, messages: 80, messageChars: 8_000, tools: 20 } as const;

/** Проверяет то, что прислала CRM, до того как тратить деньги на модель. */
export function parseCrmTurn(body: unknown): CrmTurnInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (value: unknown, max: number, what: string): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
      throw new CrmInputError(`${what}: нужна строка до ${String(max)} символов`);
    }
    return value;
  };
  const conversationId = str(b["conversationId"], 200, "conversationId");
  const system = str(b["system"], LIMITS.systemChars, "system");
  if (!Array.isArray(b["messages"]) || b["messages"].length === 0 || b["messages"].length > LIMITS.messages) {
    throw new CrmInputError(`messages: от 1 до ${String(LIMITS.messages)} сообщений`);
  }
  const messages = (b["messages"] as unknown[]).map((raw) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (m["role"] !== "user" && m["role"] !== "assistant") {
      throw new CrmInputError("messages: роль user или assistant");
    }
    const role: "user" | "assistant" = m["role"];
    return { role, content: str(m["content"], LIMITS.messageChars, "messages.content") };
  });
  if (messages.at(-1)?.role !== "user") {
    throw new CrmInputError("messages: последним должно быть сообщение user");
  }
  const rawTools = b["tools"] ?? [];
  if (!Array.isArray(rawTools) || rawTools.length > LIMITS.tools) {
    throw new CrmInputError(`tools: до ${String(LIMITS.tools)} инструментов`);
  }
  const tools = (rawTools as unknown[]).map((raw) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const schema = t["input_schema"];
    if (typeof schema !== "object" || schema === null || (schema as Record<string, unknown>)["type"] !== "object") {
      throw new CrmInputError("tools.input_schema: нужна JSON-схема объекта");
    }
    return { name: str(t["name"], 64, "tools.name"), description: str(t["description"], 2_000, "tools.description"), input_schema: schema as Record<string, unknown> };
  });
  return { conversationId, system, messages, tools };
}

/** Ответ клиенту бизнеса, когда защита остановила попытку взлома: без упоминания VoroniX. */
export function crmBlockedReply(text: string): string {
  if (/[әғқңөұүһі]/iu.test(text)) {
    return "Мен тек жазылу және біздің қызметтер туралы сұрақтарға көмектесемін. Сізге қалай көмектесе аламын?";
  }
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  const cyrillic = text.match(/[а-яё]/giu)?.length ?? 0;
  if (latin > cyrillic) {
    return "I can only help with bookings and our services. How can I help you?";
  }
  return "Я помогаю только с записью и вопросами о наших услугах. Чем могу помочь?";
}

/** Заменяет метки обратно на настоящие данные во всех строках объекта: инструменты CRM получают настоящий номер. */
export function unmaskDeep(value: unknown, vault: PiiVault): unknown {
  if (typeof value === "string") {
    return vault.unmask(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => unmaskDeep(item, vault));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmaskDeep(item, vault)]));
  }
  return value;
}

/** Строки клиента в переписке CRM начинаются с «Client: », для роутера и защиты метка не нужна. */
const clientText = (content: string): string => content.replace(/^Client:\s*/gm, "").trim();

class CrmTurn {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  lastActivity = Date.now();
  finished = false;
  readonly #queue: CrmEvent[] = [];
  #waiter: ((event: CrmEvent) => void) | null = null;
  readonly #pending = new Map<string, { resolve: (result: ToolResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #calls = 0;

  readonly toolTimeoutMs: number;

  constructor(toolTimeoutMs: number) {
    this.toolTimeoutMs = toolTimeoutMs;
  }

  emit(event: CrmEvent): void {
    if (event.status !== "tool") {
      this.finished = true;
    }
    const waiter = this.#waiter;
    if (waiter === null) {
      this.#queue.push(event);
    } else {
      this.#waiter = null;
      waiter(event);
    }
  }

  next(): Promise<CrmEvent> {
    this.lastActivity = Date.now();
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  callTool(name: string, input: unknown): Promise<ToolResult> {
    this.#calls += 1;
    const id = `call_${String(this.#calls)}`;
    const result = new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CRM не прислала результат инструмента ${name} за ${String(this.toolTimeoutMs)} мс`));
      }, this.toolTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.emit({ status: "tool", turnId: this.id, call: { id, name, input } });
    return result;
  }

  resolveTool(callId: string, result: ToolResult): boolean {
    const pending = this.#pending.get(callId);
    if (pending === undefined) {
      return false;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(callId);
    this.lastActivity = Date.now();
    pending.resolve(result);
    return true;
  }

  abort(reason: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.#pending.delete(id);
    }
    this.controller.abort();
  }
}

export interface CrmBridgeOptions {
  readonly makeEngine: (system: SystemPrompt) => ChatEngine;
  readonly log: TurnLog;
  readonly mainModel: string;
  readonly fastModel: string;
  readonly maxActive?: number;
  readonly toolTimeoutMs?: number;
  readonly maxToolRounds?: number;
}

export class CrmBusyError extends Error {}

export class CrmBridge {
  readonly #options: CrmBridgeOptions;
  readonly #turns = new Map<string, CrmTurn>();

  constructor(options: CrmBridgeOptions) {
    this.#options = options;
  }

  get activeTurns(): number {
    return this.#turns.size;
  }

  /** Начинает ход и ждёт первого события: просьбы выполнить инструмент или готового ответа. */
  start(input: CrmTurnInput): Promise<CrmEvent> {
    if (this.#turns.size >= (this.#options.maxActive ?? 8)) {
      throw new CrmBusyError("Слишком много ответов одновременно.");
    }
    const turn = new CrmTurn(this.#options.toolTimeoutMs ?? 60_000);
    this.#turns.set(turn.id, turn);
    void this.#run(turn, input);
    return this.#next(turn);
  }

  /** CRM прислала результат инструмента: ход продолжается до следующего события. */
  submit(turnId: string, callId: string, result: ToolResult): Promise<CrmEvent> | null {
    const turn = this.#turns.get(turnId);
    if (turn === undefined || !turn.resolveTool(callId, result)) {
      return null;
    }
    return this.#next(turn);
  }

  async #next(turn: CrmTurn): Promise<CrmEvent> {
    const event = await turn.next();
    if (event.status !== "tool") {
      this.#turns.delete(turn.id);
    }
    return event;
  }

  async #run(turn: CrmTurn, input: CrmTurnInput): Promise<void> {
    const started = performance.now();
    const trace = new Trace();
    const vault = new PiiVault();
    const lastUser = input.messages.at(-1)?.content ?? "";
    const question = clientText(lastUser);

    const endGuard = trace.begin("guard");
    const scan = scanInjection(question);
    const system = vault.mask(input.system).text;
    const masked: ChatMessage[] = input.messages.map((message) => ({ role: message.role, content: vault.mask(message.content).text }));
    const piiNow = new PiiVault().mask(question).total;
    const blocked = scan.score >= BLOCK_THRESHOLD;
    const guard: GuardInfo = { injection: scan.score, signals: scan.signals, pii: piiNow, blocked };
    endGuard({ injection: scan.score, pii: piiNow, blocked });

    const session = createHash("sha256").update(input.conversationId).digest("hex").slice(0, 8);
    const record = (fields: {
      outcome: TurnOutcome;
      model: string | null;
      text: string;
      route: RouteInfo | null;
      tools: { name: string; ok: boolean }[];
      error: string | null;
      reply?: Awaited<ReturnType<ChatEngine["reply"]>>;
    }): void => {
      const reply = fields.reply;
      this.#options.log.add({
        id: turn.id,
        at: new Date().toISOString(),
        session,
        role: "crm",
        model: fields.route?.model ?? this.#options.mainModel,
        outcome: fields.outcome,
        servedBy: reply?.servedBy ?? null,
        fallbackUsed: reply?.fallbackUsed ?? false,
        requestId: reply?.requestId ?? null,
        stopReason: reply?.stopReason ?? null,
        firstTextMs: reply?.timing.firstTextMs ?? null,
        totalMs: Math.round(performance.now() - started),
        inputTokens: reply?.inputTokens ?? null,
        outputTokens: reply?.outputTokens ?? null,
        cacheReadTokens: reply?.cacheReadTokens ?? null,
        cacheWriteTokens: reply?.cacheWriteTokens ?? null,
        inputChars: question.length,
        outputChars: fields.text.length,
        route: fields.route,
        tools: fields.tools,
        guard,
        error: fields.error,
        trace: trace.spans,
      });
    };

    if (blocked) {
      const text = crmBlockedReply(question);
      record({ outcome: "blocked", model: null, text, route: null, tools: [], error: null });
      turn.emit({ status: "done", turnId: turn.id, outcome: "blocked", text, model: null, route: null, guard, usage: { input_tokens: 0, output_tokens: 0 } });
      return;
    }

    const endRouter = trace.begin("router");
    const routed = routeQuestion(question, { role: "client", topScore: null, mainModel: this.#options.mainModel, fastModel: this.#options.fastModel });
    const route: RouteInfo = { model: routed.model, tier: routed.tier, reason: routed.reason };
    endRouter({ tier: route.tier });

    const tools: { name: string; ok: boolean }[] = [];
    const runner: ToolRunner = {
      definitions: input.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema }) as ToolDefinition),
      execute: async (name, rawInput) => {
        const end = trace.begin(`tool:${name}`);
        try {
          const result = await turn.callTool(name, unmaskDeep(rawInput, vault));
          tools.push({ name, ok: !result.isError });
          end({ ok: !result.isError });
          return { content: vault.mask(result.content).text, isError: result.isError };
        } catch (error) {
          tools.push({ name, ok: false });
          end({ ok: false });
          throw error;
        }
      },
    };

    const prompt: SystemPrompt = {
      id: "crm-business",
      version: "crm",
      text: system,
      fingerprint: createHash("sha256").update(system).digest("hex").slice(0, 12),
    };
    try {
      const endLlm = trace.begin("llm");
      const reply = await this.#options.makeEngine(prompt).reply(
        masked,
        {},
        {
          model: route.model,
          fast: route.tier === "fast",
          tools: runner,
          signal: turn.controller.signal,
          maxToolRounds: this.#options.maxToolRounds ?? 8,
        },
      );
      endLlm({ model: reply.servedBy, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, cacheRead: reply.cacheReadTokens ?? 0 });
      const outcome: TurnOutcome =
        reply.stopReason === "refusal" ? "refused" : reply.stopReason === "max_tokens" ? "truncated" : "answered";
      const text = outcome === "refused" ? "" : vault.unmask(reply.text);
      record({ outcome, model: reply.servedBy, text, route, tools, error: null, reply });
      turn.emit({
        status: "done",
        turnId: turn.id,
        outcome,
        text,
        model: reply.servedBy,
        route,
        guard,
        usage: { input_tokens: reply.inputTokens, output_tokens: reply.outputTokens },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      turn.abort(message);
      record({ outcome: "failed", model: null, text: "", route, tools, error: message });
      turn.emit({ status: "failed", turnId: turn.id, error: message });
    }
  }

  /** Убирает ходы, которые CRM бросила посреди работы. */
  sweep(idleMs = 5 * 60_000, now = Date.now()): void {
    for (const [id, turn] of this.#turns) {
      if (now - turn.lastActivity > idleMs) {
        turn.abort("ход брошен");
        this.#turns.delete(id);
      }
    }
  }
}
