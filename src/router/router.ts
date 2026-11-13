import type { Role } from "../auth/roles.ts";

/**
 * Шаг 6, роутер моделей. Простые вопросы (приветствие, короткий вопрос с готовым ответом в базе знаний)
 * идут в быструю и дешёвую модель, всё остальное в основную. Правила прозрачные: причина видна в трейсе.
 */
export const FAST_MODEL = "claude-haiku-5-5";

export interface Route {
  readonly tier: "fast" | "main";
  readonly model: string;
  readonly reason: string;
}

export interface RouteContext {
  readonly role: Role;
  /** Лучший балл поиска по базе знаний, null если поиска не было. */
  readonly topScore: number | null;
  readonly mainModel: string;
  readonly fastModel: string;
}

export const FAST_MAX_CHARS = 160;
export const STRONG_MATCH = 3;

const GREETING =
  /^(привет\S*|здравствуй\S*|добр\S+\s+\S+|спасибо|благодарю|пока|hi|hello|hey|thanks|thank\s+you|bye|сәлем\S*|сәлеметсіз\s+бе|рахмет|сау\s+болыңыз)[\s!.,?)]*$/iu;
const ACTION =
  /(демо|demo|запис|созвон|встреч|звон|перезвон|book|call|meeting|кездесу|жазыл|заявк|lead)/iu;
const COMPLEX =
  /(сравни|почему|как\s+настро|интеграц|проблем|ошибк|не\s+работает|жалоб|договор|compare|why|integrat|problem|error|issue|contract)/iu;

export function routeQuestion(text: string, context: RouteContext): Route {
  const main = (reason: string): Route => ({ tier: "main", model: context.mainModel, reason });
  const fast = (reason: string): Route => ({ tier: "fast", model: context.fastModel, reason });
  if (context.role === "manager") {
    return main("сотрудник: нужны инструменты CRM");
  }
  if (ACTION.test(text)) {
    return main("действие через инструменты");
  }
  if (COMPLEX.test(text)) {
    return main("сложный вопрос");
  }
  if (text.length > FAST_MAX_CHARS) {
    return main("длинный вопрос");
  }
  if (GREETING.test(text.trim())) {
    return fast("приветствие");
  }
  if (context.topScore !== null && context.topScore >= STRONG_MATCH) {
    return fast("короткий вопрос, ответ есть в базе знаний");
  }
  return main("по умолчанию");
}
