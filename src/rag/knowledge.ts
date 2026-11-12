import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Шаг 2, RAG: база знаний VoroniX и поиск по ней.
 * Документы лежат в knowledge/*.md, каждый раздел второго уровня (##) становится отдельным куском.
 * Поиск BM25 по словам с простой нормализацией для русского, казахского и английского:
 * без внешних сервисов и эмбеддингов, поэтому работает офлайн и полностью покрыт тестами.
 */
export interface Chunk {
  readonly id: string;
  readonly doc: string;
  readonly title: string;
  readonly text: string;
  /** Строка «Ключевые слова»: синонимы на трёх языках. В модель не уходит, только помогает поиску. */
  readonly keywords: string;
}

export interface Hit {
  readonly chunk: Chunk;
  readonly score: number;
}

export interface SearchOptions {
  readonly topK?: number;
  /** Слабее этой доли от лучшего результата в контекст не попадает. */
  readonly relative?: number;
  readonly minScore?: number;
}

const K1 = 1.2;
const B = 0.75;
const KEYWORDS_PREFIX = "Ключевые слова:";
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "и в во на с со по к ко о об от до за из у для не ни но а или что как это то же ли бы мы вы вас вам нам нас наш ваш " +
    "мне мой моя я он она они его ее их есть быть можно ли the a an to of in on for and or is are do does can with my our " +
    "your you we it me мен сен біз сіз бұл және ма ме ба бе па пе"
  ).split(" "),
);

/** Грубая нормализация: первые 5 букв длинного слова, у коротких отрезаем гласную на конце. */
export function normalizeWord(word: string): string {
  if (word.length >= 5) {
    return word.slice(0, 5);
  }
  if (word.length === 4 && /[аеиоуыэюяьйaeiouy]$/u.test(word)) {
    return word.slice(0, 3);
  }
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll("ё", "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(normalizeWord);
}

/** Разбирает один markdown-документ на куски по заголовкам второго уровня. */
export function parseDocument(file: string, raw: string): Chunk[] {
  const lines = raw.split(/\r?\n/);
  const doc = lines.find((line) => line.startsWith("# "))?.slice(2).trim() ?? file;
  const chunks: Chunk[] = [];
  let title = "";
  let body: string[] = [];
  let keywords = "";
  const flush = (): void => {
    const text = body.join("\n").trim();
    if (title !== "" && text !== "") {
      chunks.push({ id: `${file}#${String(chunks.length + 1)}`, doc, title, text, keywords });
    }
    body = [];
    keywords = "";
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      title = line.slice(3).trim();
    } else if (line.startsWith(KEYWORDS_PREFIX)) {
      keywords = line.slice(KEYWORDS_PREFIX.length).trim();
    } else if (!line.startsWith("# ")) {
      body.push(line);
    }
  }
  flush();
  return chunks;
}

interface Indexed {
  readonly chunk: Chunk;
  readonly terms: ReadonlyMap<string, number>;
  readonly length: number;
}

export class KnowledgeBase {
  readonly chunks: readonly Chunk[];
  /** Отпечаток всех документов: меняется при любой правке базы знаний. */
  readonly version: string;
  readonly #index: readonly Indexed[];
  readonly #docFreq = new Map<string, number>();
  readonly #avgLength: number;

  constructor(chunks: readonly Chunk[], version: string) {
    this.chunks = chunks;
    this.version = version;
    this.#index = chunks.map((chunk) => {
      const tokens = [chunk.title, chunk.title, chunk.doc, chunk.text, chunk.keywords].flatMap(tokenize);
      const terms = new Map<string, number>();
      for (const token of tokens) {
        terms.set(token, (terms.get(token) ?? 0) + 1);
      }
      return { chunk, terms, length: tokens.length };
    });
    for (const item of this.#index) {
      for (const term of item.terms.keys()) {
        this.#docFreq.set(term, (this.#docFreq.get(term) ?? 0) + 1);
      }
    }
    this.#avgLength = this.#index.reduce((sum, item) => sum + item.length, 0) / Math.max(1, this.#index.length);
  }

  static load(dir: string): KnowledgeBase {
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .sort();
    const hash = createHash("sha256");
    const chunks: Chunk[] = [];
    for (const file of files) {
      const raw = readFileSync(path.join(dir, file), "utf8");
      hash.update(file).update(raw);
      chunks.push(...parseDocument(file.replace(/\.md$/, ""), raw));
    }
    return new KnowledgeBase(chunks, hash.digest("hex").slice(0, 12));
  }

  search(query: string, options: SearchOptions = {}): Hit[] {
    const { topK = 3, relative = 0.45, minScore = 1.5 } = options;
    const terms = [...new Set(tokenize(query))];
    const total = this.#index.length;
    const scored = this.#index
      .map((item) => {
        let score = 0;
        for (const term of terms) {
          const tf = item.terms.get(term) ?? 0;
          if (tf > 0) {
            const df = this.#docFreq.get(term) ?? 0;
            const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
            score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * item.length) / this.#avgLength));
          }
        }
        return { chunk: item.chunk, score: Math.round(score * 100) / 100 };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    if (best < minScore) {
      return [];
    }
    return scored.filter((hit) => hit.score >= best * relative).slice(0, topK);
  }
}

const escapeAttr = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** Найденные куски для модели: в отдельном блоке, чтобы модель видела в них данные, а не инструкции. */
export function formatDocuments(hits: readonly Hit[]): string {
  const docs = hits.map(
    (hit) => `<document id="${hit.chunk.id}" title="${escapeAttr(`${hit.chunk.doc}: ${hit.chunk.title}`)}">\n${hit.chunk.text}\n</document>`,
  );
  return `<documents>\n${docs.join("\n")}\n</documents>`;
}
