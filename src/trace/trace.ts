/**
 * Шаг 7, трейсы. Каждый ответ раскладывается на шаги: защита, кэш, поиск, роутер, вызовы модели,
 * инструменты. У шага есть начало, длительность и атрибуты. Текста сообщений в трейсе нет.
 */
export type SpanAttrs = Readonly<Record<string, string | number | boolean | null>>;

export interface Span {
  readonly name: string;
  readonly startMs: number;
  readonly ms: number;
  readonly attrs: SpanAttrs;
}

export class Trace {
  readonly #origin = performance.now();
  readonly #spans: Span[] = [];

  /** Миллисекунды от начала хода. */
  now(): number {
    return Math.round(performance.now() - this.#origin);
  }

  begin(name: string): (attrs?: SpanAttrs) => void {
    const start = this.now();
    return (attrs = {}) => {
      this.#spans.push({ name, startMs: start, ms: this.now() - start, attrs });
    };
  }

  add(name: string, startMs: number, ms: number, attrs: SpanAttrs = {}): void {
    this.#spans.push({ name, startMs, ms, attrs });
  }

  get spans(): readonly Span[] {
    return [...this.#spans].sort((a, b) => a.startMs - b.startMs);
  }
}
