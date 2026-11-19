import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Шаг 4, роли. Посетитель сайта это client: ему доступна только запись на демо.
 * У сотрудников личные входы и три роли:
 * - operator: отвечает клиентам, видит заявки, но не выгружает базу;
 * - manager: всё, что оператор, плюс выгрузка заявок;
 * - owner: всё, что менеджер, плюс журнал доступа.
 * Права проверяет сервер при каждом вызове инструмента и каждом запросе консоли, а не модель.
 */
export const ROLES = ["client", "operator", "manager", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: readonly Role[] = ["operator", "manager", "owner"];

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  client: "клиент",
  operator: "оператор",
  manager: "менеджер",
  owner: "владелец",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isStaff(role: Role): boolean {
  return role !== "client";
}

/** Сравнение пароля за постоянное время. Короткий пароль на сервере считается не заданным. */
export function passwordMatches(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== "string" || expected === undefined || expected.length < 8) {
    return false;
  }
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
