import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isRole, type Role } from "./roles.ts";

/**
 * Шаг 4, токен сотрудника: подписанный HMAC-SHA256 пропуск с ролью и сроком жизни.
 * Формат vx1.<данные>.<подпись>, как JWT, но без лишних алгоритмов: подделать роль или продлить срок нельзя.
 * Выход отзывает токен по его jti, даже если срок ещё не истёк.
 */
export interface TokenClaims {
  readonly sub: string;
  readonly role: Role;
  /** Время выдачи и истечения, секунды Unix. */
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export type TokenCheck =
  | { readonly ok: true; readonly claims: TokenClaims }
  | { readonly ok: false; readonly reason: "missing" | "malformed" | "bad_signature" | "expired" | "revoked" };

const b64 = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

export class TokenIssuer {
  readonly #secret: Buffer;
  readonly #ttlSec: number;
  readonly #now: () => number;
  readonly #revoked = new Map<string, number>();

  constructor(options: { readonly secret?: string; readonly ttlSec: number; readonly now?: () => number }) {
    this.#secret = options.secret !== undefined && options.secret.length >= 32 ? Buffer.from(options.secret) : randomBytes(32);
    this.#ttlSec = options.ttlSec;
    this.#now = options.now ?? (() => Date.now());
  }

  get ttlSec(): number {
    return this.#ttlSec;
  }

  #sign(payload: string): string {
    return b64(createHmac("sha256", this.#secret).update(`vx1.${payload}`).digest());
  }

  issue(sub: string, role: Role): { readonly token: string; readonly claims: TokenClaims } {
    const iat = Math.floor(this.#now() / 1000);
    const claims: TokenClaims = { sub, role, iat, exp: iat + this.#ttlSec, jti: randomBytes(9).toString("base64url") };
    const payload = b64(JSON.stringify(claims));
    return { token: `vx1.${payload}.${this.#sign(payload)}`, claims };
  }

  verify(token: string | undefined): TokenCheck {
    if (token === undefined || token === "") {
      return { ok: false, reason: "missing" };
    }
    const [version, payload, signature, extra] = token.split(".");
    if (version !== "vx1" || payload === undefined || signature === undefined || extra !== undefined) {
      return { ok: false, reason: "malformed" };
    }
    const expected = Buffer.from(this.#sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return { ok: false, reason: "bad_signature" };
    }
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (typeof claims !== "object" || claims === null) {
      return { ok: false, reason: "malformed" };
    }
    const c = claims as Record<string, unknown>;
    if (typeof c["sub"] !== "string" || !isRole(c["role"]) || typeof c["exp"] !== "number" || typeof c["iat"] !== "number" || typeof c["jti"] !== "string") {
      return { ok: false, reason: "malformed" };
    }
    if (c["exp"] * 1000 <= this.#now()) {
      return { ok: false, reason: "expired" };
    }
    if (this.#revoked.has(c["jti"])) {
      return { ok: false, reason: "revoked" };
    }
    return { ok: true, claims: { sub: c["sub"], role: c["role"], iat: c["iat"], exp: c["exp"], jti: c["jti"] } };
  }

  revoke(claims: TokenClaims): void {
    const now = this.#now();
    for (const [jti, exp] of this.#revoked) {
      if (exp * 1000 <= now) {
        this.#revoked.delete(jti);
      }
    }
    this.#revoked.set(claims.jti, claims.exp);
  }
}
