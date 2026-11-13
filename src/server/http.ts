import type { IncomingMessage, ServerResponse } from "node:http";

/** Ошибка, которую сервер отдаёт клиенту как JSON с понятным текстом. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, code: string, message: string, headers: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** Только свои скрипты, стили и запросы: встроенный в страницу чужой код не выполнится. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("content-security-policy", CONTENT_SECURITY_POLICY);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

const tooLarge = (): HttpError => new HttpError(413, "payload_too_large", "Запрос слишком большой.");

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limitBytes) {
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Читает JSON. Требует Content-Type: application/json: обычная HTML-форма с чужого сайта
 * такой заголовок поставить не может, это часть защиты от подделки запросов.
 */
export async function readJson(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(415, "unsupported_media_type", "Ожидается JSON с заголовком Content-Type: application/json.");
  }
  const raw = (await readBody(req, limitBytes)).toString("utf8");
  if (raw.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "bad_json", "Тело запроса не является корректным JSON.");
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    if (name !== "" && !cookies.has(name)) {
      cookies.set(name, part.slice(index + 1).trim());
    }
  }
  return cookies;
}

export interface CookieOptions {
  readonly maxAgeSec: number;
  /** Secure: кука уходит только по HTTPS. Включается на боевом сервере. */
  readonly secure: boolean;
}

/** HttpOnly: скрипты страницы куку не видят. SameSite=Strict: с чужих сайтов она не отправляется. */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  return [
    `${name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${options.maxAgeSec}`,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const plain = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return plain === "::1" || plain.startsWith("127.");
}

/**
 * Адрес клиента. За прокси хостинга (Render и подобные) сокет видит только прокси,
 * а настоящий адрес прокси дописывает последним в X-Forwarded-For. Берём последний:
 * первые записи клиент может подделать сам.
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  if (trustProxy && header !== undefined) {
    const last = header.split(",").map((part) => part.trim()).filter((part) => part !== "").at(-1);
    if (last !== undefined) {
      return last;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Браузер всегда присылает Origin в POST. Если он есть и не наш, запрос пришёл с чужого сайта. */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) {
    return true;
  }
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
