import Anthropic from "@anthropic-ai/sdk";

/**
 * Клиент Anthropic. Ключ берётся из окружения (ANTHROPIC_API_KEY), в коде его нет.
 * maxRetries: SDK сам повторяет 408/409/429/5xx и обрывы соединения.
 */
export function createClient(): Anthropic {
  return new Anthropic({ maxRetries: 3 });
}
