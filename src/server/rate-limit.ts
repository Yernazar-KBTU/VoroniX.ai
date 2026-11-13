export interface RateLimitResult {
  readonly ok: boolean;
  /** Через сколько секунд можно снова, если ok = false. */
  readonly retryAfterSec: number;
}

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

/**
 * Скользящее окно: не больше limit сообщений за windowMs с одного адреса.
 * Каждый ответ модели стоит денег, поэтому поток сообщений с одного адреса режется до модели.
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();

  constructor(options: RateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? (() => Date.now());
  }

  hit(key: string): RateLimitResult {
    const now = this.#now();
    const recent = (this.#hits.get(key) ?? []).filter((time) => time > now - this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > 10_000) {
      this.#prune(now);
    }
    return { ok: true, retryAfterSec: 0 };
  }

  #prune(now: number): void {
    for (const [key, times] of this.#hits) {
      if ((times.at(-1) ?? 0) <= now - this.#windowMs) {
        this.#hits.delete(key);
      }
    }
  }
}
