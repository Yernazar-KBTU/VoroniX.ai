import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Шаг 4, роли. Посетитель сайта это client: ему доступны только инструменты записи на демо.
 * Сотрудник входит по паролю и получает роль manager: заявки из CRM, консоль и MCP.
 * Права проверяет сервер при каждом вызове инструмента, а не модель.
 */
export const ROLES = ["client", "manager"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Readonly<Record<Role, string>> = { client: "клиент", manager: "менеджер" };

/** Сравнение пароля за постоянное время. Короткий пароль на сервере считается не заданным. */
export function passwordMatches(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || expected === undefined || expected.length < 8) {
    return false;
  }
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
