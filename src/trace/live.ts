import type { TurnRecord } from "../chat/turn-log.ts";
import { estimateTurnCostUsd } from "./cost.ts";

/**
 * Шаг 7, слежка в реальном времени. Каждое событие сервера (ответ со всеми шагами, вход, отказ в доступе)
 * сразу уходит во вкладку «Слежка» консоли. Текста сообщений здесь нет, только метрики, как и в журнале.
 */
export type LiveKind = "turn" | "auth" | "deny";

export interface LiveEvent {
  readonly seq: number;
  readonly at: string;
  readonly kind: LiveKind;
  readonly data: Readonly<Record<string, unknown>>;
}

type Listener = (event: LiveEvent) => void;

export class LiveFeed {
  readonly #capacity: number;
  readonly #events: LiveEvent[] = [];
  readonly #listeners = new Set<Listener>();
  #seq = 0;

  constructor(capacity = 300) {
    this.#capacity = capacity;
  }

  publish(kind: LiveKind, data: Readonly<Record<string, unknown>>): LiveEvent {
    this.#seq += 1;
    const event: LiveEvent = { seq: this.#seq, at: new Date().toISOString(), kind, data };
    this.#events.push(event);
    if (this.#events.length > this.#capacity) {
      this.#events.shift();
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Отвалившийся зритель не мешает остальным.
      }
    }
    return event;
  }

  /** Ответ модели: запись журнала плюс цена. */
  turn(record: TurnRecord): LiveEvent {
    return this.publish("turn", { ...record, costUsd: estimateTurnCostUsd(record) });
  }

  recent(): readonly LiveEvent[] {
    return [...this.#events];
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  get watchers(): number {
    return this.#listeners.size;
  }
}
