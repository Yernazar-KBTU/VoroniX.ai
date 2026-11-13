import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantConfig } from "../config/assistant.ts";
import type { SystemPrompt } from "../prompt/system-prompt.ts";

export type ChatMessage = Anthropic.Beta.Messages.BetaMessageParam;
export type StreamRequest = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];
export type ToolDefinition = Anthropic.Beta.Messages.BetaTool;

/** Бета-флаг серверного повтора на запасной модели при отказе по политике безопасности. */
export const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface RequestOptions {
  /** Модель для этого запроса (роутер, шаг 6). По умолчанию из конфига. */
  readonly model?: string;
  /** Быстрый режим: без размышлений, усилие low, без запасной модели. */
  readonly fast?: boolean;
  /** Кэш промпта (шаг 6): системный промпт и вся история до последнего сообщения читаются из кэша. */
  readonly cache?: boolean;
  readonly tools?: readonly ToolDefinition[];
  /** Последний круг инструментов: модель должна ответить текстом. */
  readonly finalRound?: boolean;
}

/**
 * Собирает запрос к Messages API. Чистая функция: без сети, поэтому покрыта тестами.
 * system = null означает «голую» модель без системного промпта (режим «до» в демонстрации).
 */
export function buildRequest(
  config: AssistantConfig,
  system: SystemPrompt | null,
  messages: readonly ChatMessage[],
  options: RequestOptions = {},
): StreamRequest {
  if (messages.length === 0 || messages[0]?.role !== "user") {
    throw new Error("A conversation must start with a user message");
  }
  const fast = options.fast === true;
  const cache = options.cache === true;
  const tools = options.tools ?? [];
  return {
    model: options.model ?? config.model,
    max_tokens: config.maxTokens,
    output_config: { effort: fast ? "low" : config.effort },
    ...(fast ? { thinking: { type: "disabled" as const } } : {}),
    messages: [...messages],
    ...(system === null
      ? {}
      : {
          system: cache
            ? [{ type: "text" as const, text: system.text, cache_control: { type: "ephemeral" as const } }]
            : system.text,
        }),
    ...(cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    ...(tools.length > 0
      ? { tools: [...tools], ...(options.finalRound === true ? { tool_choice: { type: "none" as const } } : {}) }
      : {}),
    ...(config.refusalFallback && !fast ? { betas: [REFUSAL_FALLBACK_BETA], fallbacks: "default" as const } : {}),
  };
}
