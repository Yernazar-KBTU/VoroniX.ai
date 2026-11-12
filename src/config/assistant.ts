import { asObject, parseEnum, readBoolean, readEnum, readPositiveInt, readString } from "./validate.ts";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** Настройки работы ассистента: модель, усилие, версия промпта. */
export interface AssistantConfig {
  readonly name: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly effort: Effort;
  readonly maxTokens: number;
  /** Повторить запрос на запасной модели, если основная откажет по политике безопасности. */
  readonly refusalFallback: boolean;
}

const WHERE = "assistant";

export function parseAssistantConfig(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AssistantConfig {
  const obj = asObject(raw, WHERE);
  const modelOverride = env["VORONIX_MODEL"]?.trim();
  const effortOverride = env["VORONIX_EFFORT"]?.trim();
  return {
    name: readString(obj, "name", WHERE),
    promptVersion: readString(obj, "promptVersion", WHERE),
    model: modelOverride !== undefined && modelOverride !== "" ? modelOverride : readString(obj, "model", WHERE),
    effort:
      effortOverride !== undefined && effortOverride !== ""
        ? parseEnum(effortOverride, EFFORT_LEVELS, "VORONIX_EFFORT")
        : readEnum(obj, "effort", EFFORT_LEVELS, WHERE),
    maxTokens: readPositiveInt(obj, "maxTokens", WHERE),
    refusalFallback: readBoolean(obj, "refusalFallback", WHERE),
  };
}
