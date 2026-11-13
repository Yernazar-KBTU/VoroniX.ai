/**
 * Шаг 5, защита: личные данные не уходят в модель.
 * Телефоны и email заменяются метками вида [ТЕЛЕФОН_1]; настоящее значение хранится только в памяти
 * сервера для этого диалога и подставляется обратно лишь там, где оно нужно: в инструменте записи
 * и в ответе самому человеку. ИИН и номера карт не хранятся вовсе.
 */
export type PiiKind = "phone" | "email" | "iin" | "card";

const LABELS: Readonly<Record<PiiKind, string>> = { phone: "ТЕЛЕФОН", email: "EMAIL", iin: "ИИН", card: "КАРТА" };
const REVERSIBLE: ReadonlySet<PiiKind> = new Set<PiiKind>(["phone", "email"]);

/** Проверка номера карты по алгоритму Луна: отсекает случайные длинные числа. */
export function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits.charAt(digits.length - 1 - index));
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

interface Rule {
  readonly kind: PiiKind;
  readonly pattern: RegExp;
  readonly valid?: (match: string) => boolean;
}

const RULES: readonly Rule[] = [
  { kind: "email", pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu },
  { kind: "card", pattern: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, valid: luhn },
  { kind: "iin", pattern: /(?<!\d)\d{12}(?!\d)/g },
  { kind: "phone", pattern: /(?<![\d+])(?:\+7|8|7)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/g },
  { kind: "phone", pattern: /(?<![\d+])\+\d{1,3}(?:[\s()-]*\d){8,12}(?!\d)/g },
];

export type PiiCounts = Readonly<Record<PiiKind, number>>;

export interface MaskResult {
  readonly text: string;
  readonly counts: PiiCounts;
  readonly total: number;
}

const normalize = (kind: PiiKind, value: string): string =>
  kind === "email" ? value.trim().toLowerCase() : value.replace(/\D/g, "").replace(/^8/, "7");

export class PiiVault {
  readonly #placeholders = new Map<string, string>();
  readonly #values = new Map<string, string>();
  readonly #next: Record<PiiKind, number> = { phone: 0, email: 0, iin: 0, card: 0 };

  get size(): number {
    return this.#values.size;
  }

  mask(text: string): MaskResult {
    const counts: Record<PiiKind, number> = { phone: 0, email: 0, iin: 0, card: 0 };
    let result = text;
    for (const rule of RULES) {
      result = result.replace(rule.pattern, (match) => {
        if (rule.valid !== undefined && !rule.valid(match)) {
          return match;
        }
        counts[rule.kind] += 1;
        return this.#placeholder(rule.kind, match);
      });
    }
    return { text: result, counts, total: counts.phone + counts.email + counts.iin + counts.card };
  }

  /** Подставляет настоящие значения вместо меток этого диалога. Чужие или выдуманные метки остаются как есть. */
  unmask(text: string): string {
    return text.replace(/\[(?:ТЕЛЕФОН|EMAIL)_\d+\]/gu, (placeholder) => this.#values.get(placeholder) ?? placeholder);
  }

  clear(): void {
    this.#placeholders.clear();
    this.#values.clear();
    this.#next.phone = 0;
    this.#next.email = 0;
  }

  #placeholder(kind: PiiKind, value: string): string {
    if (!REVERSIBLE.has(kind)) {
      return `[${LABELS[kind]}]`;
    }
    const key = `${kind}:${normalize(kind, value)}`;
    const existing = this.#placeholders.get(key);
    if (existing !== undefined) {
      return existing;
    }
    this.#next[kind] += 1;
    const placeholder = `[${LABELS[kind]}_${String(this.#next[kind])}]`;
    this.#placeholders.set(key, placeholder);
    this.#values.set(placeholder, value.trim());
    return placeholder;
  }
}

/** Сколько личных данных в тексте в открытом виде. Трейс проверяет этим, что в модель ушёл ноль. */
export function countRawPii(text: string): number {
  let count = 0;
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.valid === undefined || rule.valid(match[0])) {
        count += 1;
      }
    }
  }
  return count;
}

/** Контакт для сотрудника: видно, что он есть и чей он, но целиком не раскрыт. */
export function maskContact(value: string): string {
  const at = value.indexOf("@");
  if (at > 0) {
    return `${value.slice(0, 1)}***${value.slice(at)}`;
  }
  const digits = value.replace(/\D/g, "");
  return digits.length < 6 ? "***" : `+${digits.slice(0, 4)} *** ** ${digits.slice(-2)}`;
}

/**
 * Поток ответа для человека: метки заменяются его же данными. Метка может прийти по частям
 * («[ТЕЛЕ» и «ФОН_1]»), поэтому незакрытую скобку придерживаем до следующего кусочка.
 */
export class UnmaskingStream {
  readonly #emit: (text: string) => void;
  readonly #unmask: (text: string) => string;
  #pending = "";

  constructor(emit: (text: string) => void, unmask: (text: string) => string) {
    this.#emit = emit;
    this.#unmask = unmask;
  }

  write(delta: string): void {
    const text = this.#pending + delta;
    const open = text.lastIndexOf("[");
    if (open >= 0 && !text.includes("]", open) && text.length - open <= 24) {
      this.#send(text.slice(0, open));
      this.#pending = text.slice(open);
      return;
    }
    this.#pending = "";
    this.#send(text);
  }

  flush(): void {
    const rest = this.#pending;
    this.#pending = "";
    this.#send(rest);
  }

  #send(text: string): void {
    if (text !== "") {
      this.#emit(this.#unmask(text));
    }
  }
}
