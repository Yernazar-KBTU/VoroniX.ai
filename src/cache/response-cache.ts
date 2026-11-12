import { createHash } from "node:crypto";
import type { SourceRef } from "../chat/turn-log.ts";

/**
 * Шаг 6, кэш частых вопросов. Первый вопрос диалога без личных данных («Что умеет VoroniX?»)
 * после первого ответа отдаётся из памяти: мгновенно и за ноль токенов. Ключ включает версию
 * промпта и базы знаний, поэтому после их правки старые ответы не возвращаются.
 */
export interface CachedAnswer {
  readonly text: string;
  readonly servedBy: string;
  readonly sources: readonly SourceRef[];
  readonly at: number;
}

export interface ResponseCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly now?: () => number;
}

export function normalizeQuestion(text: string): string {
  return text.toLowerCase().replaceAll("ё", "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export class ResponseCache {
  readonly #entries = new Map<string, CachedAnswer>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  #hits = 0;
  #misses = 0;

  constructor(options: ResponseCacheOptions) {
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? (() => Date.now());
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

  stats(): { readonly hits: number; readonly misses: number; readonly size: number } {
    return { hits: this.#hits, misses: this.#misses, size: this.#entries.size };
  }
}
