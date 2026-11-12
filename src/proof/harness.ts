import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { PROJECT_ROOT } from "../config/paths.ts";
import { parseSseEvent } from "../server/sse.ts";
import type { TurnMeta } from "../chat/turn-log.ts";

/**
 * Общие инструменты доказательств для всех этапов: задать вопрос живому серверу так же,
 * как это делает браузер, проверить ответ, прогнать тесты, снять скриншоты.
 */

/** Цены Anthropic в долларах за 1 млн токенов. Проверено 12.11.2026 по PRICING_SOURCE. */
export const PRICES_USD_PER_MTOK: Readonly<
  Record<string, { readonly input: number; readonly output: number; readonly cacheRead: number }>
> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
/** Запись в кэш промпта на 5 минут стоит 1,25 цены входа. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

export function estimateCostUsd(model: string | null, inputTokens: number, outputTokens: number): number | null {
  const price = model === null ? undefined : PRICES_USD_PER_MTOK[model];
  if (price === undefined) {
    return null;
  }
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Цена хода с учётом кэша промпта: прочитанное из кэша в разы дешевле обычного входа. */
export function estimateTurnCostUsd(meta: TurnMeta | null): number | null {
  if (meta === null) {
    return null;
  }
  if (meta.servedBy === null || meta.inputTokens === null || meta.outputTokens === null) {
    return 0;
  }
  const price = PRICES_USD_PER_MTOK[meta.servedBy];
  if (price === undefined) {
    return null;
  }
  const read = meta.cacheReadTokens ?? 0;
  const write = meta.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, meta.inputTokens - read - write);
  if (meta.cached === true) {
    return 0;
  }
  return (fresh * price.input + write * price.input * CACHE_WRITE_MULTIPLIER + read * price.cacheRead + meta.outputTokens * price.output) / 1_000_000;
}

export interface AskOptions {
  readonly cookie?: string | null;
  /** Оборвать соединение после первого кусочка текста: как кнопка «Стоп» или закрытая вкладка. */
  readonly stopAfterFirstText?: boolean;
}

export interface AskResult {
  readonly question: string;
  readonly answer: string;
  readonly outcome: string;
  readonly meta: TurnMeta | null;
  readonly error: string | null;
  /** Время глазами клиента: от отправки до первого слова и до конца. */
  readonly clientFirstTextMs: number | null;
  readonly clientTotalMs: number;
  readonly cookie: string | null;
}

export async function ask(baseUrl: string, question: string, options: AskOptions = {}): Promise<AskResult> {
  const controller = new AbortController();
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.cookie !== undefined && options.cookie !== null) {
    headers["cookie"] = options.cookie;
  }
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: question }),
    signal: controller.signal,
  });
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie === null ? (options.cookie ?? null) : (setCookie.split(";")[0] ?? null);
  if (!response.ok || response.body === null) {
    const body = await response.text();
    return {
      question,
      answer: "",
      outcome: "http_error",
      meta: null,
      error: `${response.status} ${body}`,
      clientFirstTextMs: null,
      clientTotalMs: elapsed(),
      cookie,
    };
  }

  let answer = "";
  let first: number | null = null;
  let meta: TurnMeta | null = null;
  let error: string | null = null;
  let outcome = "no_result";
  let stop = false;
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!stop) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0 && !stop) {
        const event = parseSseEvent(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\n\n");
        if (event?.name === "delta") {
          first ??= elapsed();
          answer += (event.data as { text: string }).text;
          if (options.stopAfterFirstText === true) {
            controller.abort();
            outcome = "stopped_by_client";
            stop = true;
          }
        } else if (event?.name === "done") {
          meta = event.data as TurnMeta;
          outcome = meta.outcome;
        } else if (event?.name === "error") {
          error = (event.data as { message: string }).message;
          outcome = "failed";
        }
      }
    }
  } catch (caught) {
    if (!controller.signal.aborted) {
      throw caught;
    }
  }
  return { question, answer, outcome, meta, error, clientFirstTextMs: first, clientTotalMs: elapsed(), cookie };
}

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const found = (text: string, words: readonly string[]): string[] =>
  words.filter((word) => text.toLowerCase().includes(word.toLowerCase()));

/** Простые прозрачные проверки ответа. Полноценные эвалы с оценкой моделью появятся на шаге 7. */
export const check = {
  answered(result: AskResult): Check {
    return {
      name: "Ответ получен",
      pass: result.outcome === "answered",
      detail: result.error ?? `итог: ${result.outcome}`,
    };
  },
  noDashes(text: string): Check {
    const count = text.match(/[–—]/g)?.length ?? 0;
    return { name: "Нет длинных тире", pass: count === 0, detail: count === 0 ? "тире нет" : `тире: ${count}` };
  },
  mentionsAny(name: string, text: string, words: readonly string[]): Check {
    const hits = found(text, words);
    return { name, pass: hits.length > 0, detail: hits.length > 0 ? `найдено: ${hits.join(", ")}` : `нет ни одного из: ${words.join(", ")}` };
  },
  mentionsNone(name: string, text: string, words: readonly string[]): Check {
    const hits = found(text, words);
    return { name, pass: hits.length === 0, detail: hits.length === 0 ? "ни одного не найдено" : `найдено: ${hits.join(", ")}` };
  },
  kazakh(text: string): Check {
    const count = text.match(/[әғқңөұүһі]/giu)?.length ?? 0;
    return { name: "Ответ на казахском", pass: count >= 5, detail: `казахских букв: ${count}` };
  },
  english(text: string): Check {
    const latin = text.match(/[a-z]/gi)?.length ?? 0;
    const cyrillic = text.match(/[а-яё]/giu)?.length ?? 0;
    const share = latin / Math.max(1, latin + cyrillic);
    return { name: "Ответ на английском", pass: share >= 0.9, detail: `латиница ${Math.round(share * 100)}%` };
  },
  noPrices(text: string): Check {
    const match = text.match(/\d[\d\s.,]*\s?(₸|тенге|\$|usd|долл|руб|kzt|€)|(\$|€|₸)\s?\d/iu);
    return {
      name: "Не выдумывает цену",
      pass: match === null,
      detail: match === null ? "сумм с валютой нет" : `найдено: «${match[0]}»`,
    };
  },
};

export interface TestRun {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly output: string;
}

/** Прогоняет все юнит-тесты и сохраняет вывод как есть. */
export function runUnitTests(): TestRun {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", "test/**/*.test.ts"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  const count = (label: string): number => Number(new RegExp(`ℹ ${label} (\\d+)`).exec(output)?.[1] ?? "0");
  return { total: count("tests"), pass: count("pass"), fail: count("fail"), output };
}

export function gitInfo(): { readonly commit: string; readonly dirty: boolean } {
  try {
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
    return { commit: git("rev-parse", "--short", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

/* ---------- Playwright: минимальное описание того, что нужно для скриншотов ---------- */
export interface PwPage {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  press(selector: string, key: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { readonly state?: "attached" | "visible"; readonly timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  type(selector: string, text: string, options?: { readonly delay?: number }): Promise<void>;
  readonly mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
  screenshot(options: { readonly path: string; readonly fullPage?: boolean }): Promise<unknown>;
}

export interface PwContext {
  newPage(): Promise<PwPage>;
  cookies(): Promise<readonly object[]>;
  addCookies(cookies: readonly object[]): Promise<void>;
  close(): Promise<void>;
}

export interface PwBrowser {
  newContext(options?: Readonly<Record<string, unknown>>): Promise<PwContext>;
  close(): Promise<void>;
}

export interface Playwright {
  readonly chromium: { launch(): Promise<PwBrowser> };
  readonly devices: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** Playwright не входит в зависимости проекта: если его нет, скриншоты просто пропускаются. */
export function loadPlaywright(): Playwright | null {
  try {
    return createRequire(import.meta.url)("playwright") as Playwright;
  } catch {
    return null;
  }
}

export const formatMs = (ms: number | null): string => (ms === null ? "нет" : `${(ms / 1000).toFixed(1).replace(".", ",")} с`);

export const formatUsd = (usd: number | null): string => (usd === null ? "нет цены" : `$${usd.toFixed(4)}`);
