import { PiiVault } from "../guard/pii.ts";
import type { ChatMessage } from "../llm/request.ts";
import type { TurnMeta } from "./turn-log.ts";

/** Сообщение для окна чата: только текст и метрики, без служебных блоков модели. */
export interface TranscriptEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly meta?: TurnMeta;
}

const MAX_TRANSCRIPT = 200;

/**
 * Один диалог с клиентом. history уходит в модель как есть (с блоками размышлений),
 * transcript показывается в окне чата. Пока идёт ответ, диалог занят.
 */
export class Conversation {
  #history: readonly ChatMessage[] = [];
  readonly #transcript: TranscriptEntry[] = [];
  #busy = false;
  /** Метки личных данных этого диалога (шаг 5): живут столько же, сколько диалог. */
  readonly vault = new PiiVault();

  get history(): readonly ChatMessage[] {
    return this.#history;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.#transcript;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** Занимает диалог. false, если в нём уже идёт ответ. */
  tryLock(): boolean {
    if (this.#busy) {
      return false;
    }
    this.#busy = true;
    return true;
  }

  unlock(): void {
    this.#busy = false;
  }

  commit(history: readonly ChatMessage[], entries: readonly TranscriptEntry[]): void {
    this.#history = history;
    this.#transcript.push(...entries);
    if (this.#transcript.length > MAX_TRANSCRIPT) {
      this.#transcript.splice(0, this.#transcript.length - MAX_TRANSCRIPT);
    }
  }

  /** Начать диалог заново. false, если сейчас идёт ответ. */
  reset(): boolean {
    if (this.#busy) {
      return false;
    }
    this.#history = [];
    this.#transcript.length = 0;
    this.vault.clear();
    return true;
  }
}
