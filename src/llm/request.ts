import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantConfig } from "../config/assistant.ts";
import type { SystemPrompt } from "../prompt/system-prompt.ts";

export type ChatMessage = Anthropic.Beta.Messages.BetaMessageParam;
export type StreamRequest = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** Бета-флаг серверного повтора на запасной модели при отказе по политике безопасности. */
export const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Собирает запрос к Messages API. Чистая функция: без сети, поэтому покрыта тестами.
 * system = null означает «голую» модель без системного промпта (режим «до» в демонстрации).
 */
export function buildRequest(
  config: AssistantConfig,
  system: SystemPrompt | null,
  messages: readonly ChatMessage[],
): StreamRequest {
  if (messages.length === 0 || messages[0]?.role !== "user") {
    throw new Error("A conversation must start with a user message");
  }
  return {
    model: config.model,
    max_tokens: config.maxTokens,
    output_config: { effort: config.effort },
    messages: [...messages],
    ...(system === null ? {} : { system: system.text }),
    ...(config.refusalFallback ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}
