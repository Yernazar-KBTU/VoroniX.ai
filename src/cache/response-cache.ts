import { createHash } from "node:crypto";
import type { SourceRef } from "../chat/turn-log.ts";
import { meaningOf, similarity, type Meaning, type Weigh } from "./semantic.ts";

/**
 * Шаг 6, кэш частых вопросов. Первый вопрос диалога без личных данных («Что умеет VoroniX?»)
 * после первого ответа отдаётся из памяти: мгновенно и за ноль токенов. Ключ включает версию
 * промпта и базы знаний, поэтому после их правки старые ответы не возвращаются.
 * Умный кэш: если точного совпадения нет, ищем вопрос, похожий по смыслу («Что умеет VoroniX?»
 * и «Какие функции у VoroniX?»), на нашем же поиске, без внешних сервисов.
 */
export interface CachedAnswer {
  readonly text: string;
  readonly servedBy: string;
  readonly sources: readonly SourceRef[];
  readonly at: number;
  /** Смысл исходного вопроса и версия: по ним ищутся похожие вопросы. */
  readonly meaning?: Meaning;
  readonly version?: string;
}

export interface CacheMatch {
  readonly key: string;
  readonly answer: CachedAnswer;
  readonly kind: "exact" | "semantic";
  readonly similarity: number;
}

export interface ResponseCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly now?: () => number;
  /** Вес слова (редкость в базе знаний). По умолчанию все слова весят 1. */
  readonly weigh?: Weigh;
  /** С какой похожести вопрос считается тем же. */
  readonly threshold?: number;
}

export const SEMANTIC_THRESHOLD = 0.8;

export function normalizeQuestion(text: string): string {
  return text.toLowerCase().replaceAll("ё", "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export class ResponseCache {
  readonly #entries = new Map<string, CachedAnswer>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #weigh: Weigh;
  readonly #threshold: number;
  #hits = 0;
  #semanticHits = 0;
  #misses = 0;

  constructor(options: ResponseCacheOptions) {
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? (() => Date.now());
    this.#weigh = options.weigh ?? (() => 1);
    this.#threshold = options.threshold ?? SEMANTIC_THRESHOLD;
  }

  /** Сначала точный вопрос, потом самый похожий по смыслу среди живых записей той же версии. */
  find(question: string, version: string): CacheMatch | undefined {
    const key = this.key(question, version);
    if (this.#entries.has(key)) {
      const answer = this.get(key);
      if (answer !== undefined) {
        return { key, answer, kind: "exact", similarity: 1 };
      }
      this.#misses -= 1;
    }
    const meaning = meaningOf(question);
    let best: { key: string; score: number } | null = null;
    const now = this.#now();
    for (const [entryKey, entry] of this.#entries) {
      if (entry.version !== version || entry.meaning === undefined || now - entry.at > this.#ttlMs) {
        continue;
      }
      const score = similarity(meaning, entry.meaning, this.#weigh);
      if (score >= this.#threshold && (best === null || score > best.score)) {
        best = { key: entryKey, score };
      }
    }
    if (best === null) {
      this.#misses += 1;
      return undefined;
    }
    const answer = this.#entries.get(best.key);
    if (answer === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#entries.delete(best.key);
    this.#entries.set(best.key, answer);
    this.#semanticHits += 1;
    return { key: best.key, answer, kind: "semantic", similarity: Math.round(best.score * 100) / 100 };
  }

  /** Сохранить ответ вместе со смыслом вопроса, чтобы его нашли и похожие формулировки. */
  put(question: string, version: string, answer: Omit<CachedAnswer, "at" | "meaning" | "version">): void {
    this.set(this.key(question, version), { ...answer, meaning: meaningOf(question), version });
  }

  key(question: string, version: string): string {
    return createHash("sha256").update(`${version}\n${normalizeQuestion(question)}`).digest("hex");
  }

  get(key: string): CachedAnswer | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined || this.#now() - entry.at > this.#ttlMs) {
      if (entry !== undefined) {
        this.#entries.delete(key);
      }
      this.#misses += 1;
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#hits += 1;
    return entry;
  }

  set(key: string, answer: Omit<CachedAnswer, "at">): void {
    this.#entries.delete(key);
    this.#entries.set(key, { ...answer, at: this.#now() });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) {
        break;
      }
      this.#entries.delete(oldest);
    }
  }

  stats(): { readonly hits: number; readonly semanticHits: number; readonly misses: number; readonly size: number } {
    return { hits: this.#hits, semanticHits: this.#semanticHits, misses: this.#misses, size: this.#entries.size };
  }
}
