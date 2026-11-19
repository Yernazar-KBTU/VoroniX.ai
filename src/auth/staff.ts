import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { STAFF_ROLES, isRole, type Role } from "./roles.ts";

/**
 * Шаг 4, личные входы сотрудников. Пароли хранятся только как хэш scrypt с солью.
 * Учётные записи задаются переменной VORONIX_STAFF: "логин:роль:пароль;логин:роль:пароль".
 * Старая переменная VORONIX_MANAGER_PASSWORD даёт одну запись "manager" с ролью manager.
 */
export interface StaffAccount {
  readonly login: string;
  readonly role: Role;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

const KEY_LEN = 32;
const LOGIN = /^[a-z0-9._-]{2,32}$/;

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): { salt: Buffer; hash: Buffer } {
  return { salt, hash: scryptSync(password, salt, KEY_LEN) };
}

export function makeAccount(login: string, role: Role, password: string): StaffAccount {
  const name = login.trim().toLowerCase();
  if (!LOGIN.test(name)) {
    throw new Error(`VORONIX_STAFF: логин "${login}" должен быть 2..32 символа: латиница, цифры, . _ -`);
  }
  if (!STAFF_ROLES.includes(role)) {
    throw new Error(`VORONIX_STAFF: у "${name}" роль должна быть operator, manager или owner`);
  }
  if (password.length < 8) {
    throw new Error(`VORONIX_STAFF: у "${name}" пароль короче 8 символов`);
  }
  return { login: name, role, ...hashPassword(password) };
}

export function parseStaffEnv(staff: string | undefined, managerPassword: string | undefined): StaffAccount[] {
  const accounts: StaffAccount[] = [];
  for (const entry of (staff ?? "").split(";").map((part) => part.trim()).filter(Boolean)) {
    const [login = "", role = "", ...rest] = entry.split(":");
    const password = rest.join(":");
    if (!isRole(role)) {
      throw new Error(`VORONIX_STAFF: у "${login}" неизвестная роль "${role}"`);
    }
    accounts.push(makeAccount(login, role, password));
  }
  const legacy = managerPassword?.trim() ?? "";
  if (legacy.length >= 8 && !accounts.some((account) => account.login === "manager")) {
    accounts.push(makeAccount("manager", "manager", legacy));
  }
  return accounts;
}

/** Справочник сотрудников. Неизвестный логин проверяется против пустышки: время ответа одинаковое. */
export class StaffDirectory {
  readonly #accounts = new Map<string, StaffAccount>();
  readonly #dummy = hashPassword(randomBytes(12).toString("hex"));

  constructor(accounts: readonly StaffAccount[]) {
    for (const account of accounts) {
      this.#accounts.set(account.login, account);
    }
  }

  get size(): number {
    return this.#accounts.size;
  }

  list(): readonly { readonly login: string; readonly role: Role }[] {
    return [...this.#accounts.values()].map(({ login, role }) => ({ login, role }));
  }

  verify(login: unknown, password: unknown): StaffAccount | null {
    if (typeof password !== "string" || password.length > 256) {
      return null;
    }
    const name = typeof login === "string" ? login.trim().toLowerCase() : "";
    const account = this.#accounts.get(name);
    const salt = account?.salt ?? this.#dummy.salt;
    const expected = account?.hash ?? this.#dummy.hash;
    const ok = timingSafeEqual(scryptSync(password, salt, KEY_LEN), expected);
    return ok && account !== undefined ? account : null;
  }
}
