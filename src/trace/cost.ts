import type { TurnMeta } from "../chat/turn-log.ts";

/** Шаг 7, цена каждого ответа: её видно в консоли и в ленте слежки. */
/** Цены Anthropic в долларах за 1 млн токенов. Проверено 12.11.2026 по PRICING_SOURCE. */
export const PRICES_USD_PER_MTOK: Readonly<
  Record<string, { readonly input: number; readonly output: number; readonly cacheRead: number }>
> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  /** Запасная модель: на неё сервер Anthropic переключает, если основная отказалась отвечать. */
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
};
/** Запись в кэш промпта на 5 минут стоит 1,25 цены входа. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

export function estimateCostUsd(model: string | null, inputTokens: number, outputTokens: number): number | null {
  const price = model === null ? undefined : PRICES_USD_PER_MTOK[model];
  if (price === undefined) {
    return null;
  }
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Цена хода с учётом кэша промпта: прочитанное из кэша в разы дешевле обычного входа. */
export function estimateTurnCostUsd(meta: TurnMeta | null): number | null {
  if (meta === null) {
    return null;
  }
  if (meta.servedBy === null || meta.inputTokens === null || meta.outputTokens === null) {
    return 0;
  }
  const price = PRICES_USD_PER_MTOK[meta.servedBy];
  if (price === undefined) {
    return null;
  }
  const read = meta.cacheReadTokens ?? 0;
  const write = meta.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, meta.inputTokens - read - write);
  if (meta.cached === true) {
    return 0;
  }
  return (fresh * price.input + write * price.input * CACHE_WRITE_MULTIPLIER + read * price.cacheRead + meta.outputTokens * price.output) / 1_000_000;
}
