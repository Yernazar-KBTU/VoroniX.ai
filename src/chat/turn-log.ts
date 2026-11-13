import type { Span } from "../trace/trace.ts";

export const TURN_OUTCOMES = ["answered", "truncated", "refused", "cancelled", "failed", "blocked"] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** Метрики одного ответа: их видит клиент под ответом и сотрудник в консоли. */
export interface TurnMeta {
  readonly outcome: TurnOutcome;
  readonly servedBy: string | null;
  readonly fallbackUsed: boolean;
  readonly requestId: string | null;
  readonly firstTextMs: number | null;
  readonly totalMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Ответ взят из кэша частых вопросов: модель не вызывалась (шаг 6). */
  readonly cached?: boolean;
  /** Куда роутер отправил вопрос и почему (шаг 6). */
  readonly route?: RouteInfo | null;
  /** Документы базы знаний, на которые опирался ответ (шаг 2). */
  readonly sources?: readonly SourceRef[];
  /** Вызовы инструментов CRM (шаг 3). */
  readonly tools?: readonly { readonly name: string; readonly ok: boolean }[];
  /** Что увидела защита (шаг 5). */
  readonly guard?: GuardInfo | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
}

export interface SourceRef {
  readonly id: string;
  readonly title: string;
}

export interface RouteInfo {
  readonly model: string;
  readonly tier: "fast" | "main";
  readonly reason: string;
}

export interface GuardInfo {
  readonly injection: number;
  readonly signals: readonly string[];
  /** Сколько личных данных заменено метками до отправки модели. */
  readonly pii: number;
  readonly blocked: boolean;
}

/** Запись журнала консоли. Текст сообщений сюда не попадает: только длины и метрики. */
export interface TurnRecord extends TurnMeta {
  readonly id: string;
  readonly at: string;
  /** Короткая метка сессии, из неё не восстановить идентификатор. */
  readonly session: string;
  readonly model: string;
  readonly stopReason: string | null;
  readonly inputChars: number;
  readonly outputChars: number;
  /** Подробности ошибки для сотрудника. Клиент видит общий текст. */
  readonly error: string | null;
  /** Роль, от имени которой шёл диалог (шаг 4). */
  readonly role?: string;
  /** Трейс хода: шаги, время и атрибуты, без текста сообщений (шаг 7). */
  readonly trace?: readonly Span[];
}

export interface TurnStats {
  readonly total: number;
  readonly byOutcome: Readonly<Record<TurnOutcome, number>>;
  readonly medianFirstTextMs: number | null;
  readonly medianTotalMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Последние ответы для консоли сотрудника: кольцевой буфер фиксированного размера. */
export class TurnLog {
  readonly #capacity: number;
  readonly #records: TurnRecord[] = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("TurnLog capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  add(record: TurnRecord): void {
    this.#records.push(record);
    if (this.#records.length > this.#capacity) {
      this.#records.shift();
    }
  }

  /** Записи от новых к старым. */
  list(): readonly TurnRecord[] {
    return [...this.#records].reverse();
  }

  stats(): TurnStats {
    const byOutcome = Object.fromEntries(TURN_OUTCOMES.map((outcome) => [outcome, 0])) as Record<TurnOutcome, number>;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const record of this.#records) {
      byOutcome[record.outcome] += 1;
      inputTokens += record.inputTokens ?? 0;
      outputTokens += record.outputTokens ?? 0;
    }
    const answered = this.#records.filter((r) => r.outcome === "answered" || r.outcome === "truncated");
    return {
      total: this.#records.length,
      byOutcome,
      medianFirstTextMs: median(answered.flatMap((r) => (r.firstTextMs === null ? [] : [r.firstTextMs]))),
      medianTotalMs: median(answered.map((r) => r.totalMs)),
      inputTokens,
      outputTokens,
    };
  }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : Math.round(((sorted[middle - 1] ?? 0) + upper) / 2);
}
