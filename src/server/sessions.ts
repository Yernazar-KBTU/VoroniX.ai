import { createHash, randomBytes } from "node:crypto";
import { Conversation } from "../chat/conversation.ts";

/** 24 случайных байта в base64url: 32 символа, угадать нельзя. */
const ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export interface Session {
  readonly id: string;
  /** Короткая метка для журнала: по ней не восстановить сам идентификатор. */
  readonly tag: string;
  readonly conversation: Conversation;
  readonly createdAt: number;
  lastSeen: number;
}

export interface SessionStoreOptions {
  readonly ttlMs: number;
  readonly maxSessions: number;
  readonly now?: () => number;
}

/**
 * Сессии в памяти процесса: для одного сервера этого достаточно.
 * Map хранит сессии от давно активных к недавним, поэтому чистка и вытеснение идут с начала.
 */
export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #now: () => number;

  constructor(options: SessionStoreOptions) {
    this.#ttlMs = options.ttlMs;
    this.#maxSessions = options.maxSessions;
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** Сессия по идентификатору из куки, без создания новой. */
  find(id: string | undefined): Session | undefined {
    this.#sweep();
    if (id === undefined || !ID_PATTERN.test(id)) {
      return undefined;
    }
    const session = this.#sessions.get(id);
    if (session !== undefined) {
      this.#touch(session);
    }
    return session;
  }

  /** Сессия из куки или новая, если куки нет, она чужая или устарела. */
  resolve(id: string | undefined): { readonly session: Session; readonly created: boolean } {
    const existing = this.find(id);
    if (existing !== undefined) {
      return { session: existing, created: false };
    }
    this.#evictOverflow();
    const newId = randomBytes(24).toString("base64url");
    const now = this.#now();
    const session: Session = {
      id: newId,
      tag: createHash("sha256").update(newId).digest("hex").slice(0, 8),
      conversation: new Conversation(),
      createdAt: now,
      lastSeen: now,
    };
    this.#sessions.set(newId, session);
    return { session, created: true };
  }

  #touch(session: Session): void {
    session.lastSeen = this.#now();
    this.#sessions.delete(session.id);
    this.#sessions.set(session.id, session);
  }

  #sweep(): void {
    const cutoff = this.#now() - this.#ttlMs;
    for (const session of this.#sessions.values()) {
      if (session.lastSeen > cutoff) {
        break;
      }
      if (!session.conversation.busy) {
        this.#sessions.delete(session.id);
      }
    }
  }

  #evictOverflow(): void {
    for (const session of this.#sessions.values()) {
      if (this.#sessions.size < this.#maxSessions) {
        return;
      }
      if (!session.conversation.busy) {
        this.#sessions.delete(session.id);
      }
    }
  }
}
