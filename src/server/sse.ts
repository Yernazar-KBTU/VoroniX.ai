import type { ServerResponse } from "node:http";

export interface SseEvent {
  readonly name: string;
  readonly data: unknown;
}

/**
 * Поток событий (Server-Sent Events): ответ модели приходит в браузер по кусочкам.
 * Пинг каждые 15 секунд не даёт прокси оборвать соединение, пока модель думает.
 */
export class SseStream {
  readonly #res: ServerResponse;
  readonly #heartbeat: NodeJS.Timeout;
  #open = true;

  constructor(res: ServerResponse, headers: Readonly<Record<string, string>> = {}, heartbeatMs = 15_000) {
    this.#res = res;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      ...headers,
    });
    res.flushHeaders();
    this.#heartbeat = setInterval(() => {
      this.#write(": ping\n\n");
    }, heartbeatMs);
    this.#heartbeat.unref();
    res.once("close", () => {
      this.#stop();
    });
  }

  get open(): boolean {
    return this.#open;
  }

  send(name: string, data: unknown): void {
    this.#write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  end(): void {
    if (!this.#open) {
      return;
    }
    this.#stop();
    this.#res.end();
  }

  #write(chunk: string): void {
    if (this.#open && !this.#res.writableEnded) {
      this.#res.write(chunk);
    }
  }

  #stop(): void {
    this.#open = false;
    clearInterval(this.#heartbeat);
  }
}

/** Разбирает одно событие (текст между пустыми строками). Комментарии-пинги пропускает. */
export function parseSseEvent(raw: string): SseEvent | null {
  let name = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      name = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (data.length === 0) {
    return null;
  }
  return { name, data: JSON.parse(data.join("\n")) as unknown };
}

export function parseSseText(text: string): SseEvent[] {
  return text.split("\n\n").flatMap((chunk) => {
    const event = parseSseEvent(chunk);
    return event === null ? [] : [event];
  });
}
