import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ROLE_LABELS, passwordMatches, type Role } from "../auth/roles.ts";
import { StaffDirectory, makeAccount } from "../auth/staff.ts";
import { TokenIssuer, type TokenCheck } from "../auth/token.ts";
import type { LiveFeed } from "../trace/live.ts";
import { isObject } from "../config/validate.ts";
import type { ToolRegistry } from "../tools/crm.ts";
import { CrmBusyError, CrmInputError, parseCrmTurn, type CrmBridge } from "../crm/bridge.ts";
import { handleMcp } from "../tools/mcp.ts";
import { ChatError, type ChatErrorCode, type ChatService, type Turn } from "../chat/service.ts";
import {
  HttpError,
  applySecurityHeaders,
  clientAddress,
  isLoopbackAddress,
  isSameOrigin,
  parseCookies,
  readJson,
  sendJson,
  serializeCookie,
} from "./http.ts";
import type { ConsoleOverview, PublicInfo } from "./info.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { Session, SessionStore } from "./sessions.ts";
import { SseStream } from "./sse.ts";
import { serveStatic } from "./static.ts";

export const SESSION_COOKIE = "vx_sid";
/** Подписанный токен сотрудника (шаг 4): роль и срок жизни внутри, подделать нельзя. */
export const STAFF_COOKIE = "vx_staff";
const JSON_LIMIT_BYTES = 64 * 1024;
const CRM_LIMIT_BYTES = 512 * 1024;

export interface AppDeps {
  readonly chat: ChatService;
  readonly sessions: SessionStore;
  readonly rateLimiter: RateLimiter;
  readonly publicInfo: PublicInfo;
  readonly consoleInfo: () => ConsoleOverview;
  readonly webDir: string;
  /** Есть ли ключ API. Без него страница работает, а чат честно отвечает 503. */
  readonly ready: boolean;
  readonly secureCookies: boolean;
  readonly sessionTtlSec: number;
  /** Кому открыта консоль без входа. По умолчанию только с компьютера, где запущен сервер. */
  readonly consoleAccess?: (req: IncomingMessage) => boolean;
  /** Сервер стоит за прокси хостинга: адрес клиента берётся из X-Forwarded-For, консоль без входа не открывается. */
  readonly trustProxy?: boolean;
  /** VoroniX.ai как третий ИИ в CRM VoroniX: вход для сервера CRM по ключу VORONIX_CRM_KEY. */
  readonly crm?: { readonly bridge: CrmBridge; readonly key: string };
  /** Инструменты CRM для MCP (шаг 3). */
  readonly tools?: ToolRegistry;
  /** Старый общий пароль: превращается в учётную запись "manager". */
  readonly managerPassword?: string;
  /** Личные входы сотрудников (шаг 4). Без них вход выключен. */
  readonly staff?: StaffDirectory;
  /** Выдаёт и проверяет подписанные токены сотрудников. */
  readonly tokens?: TokenIssuer;
  /** Лента слежки в реальном времени (шаг 7). */
  readonly feed?: LiveFeed;
  /** Полная выгрузка заявок CSV: только менеджер и владелец. */
  readonly leadsCsv?: () => string;
  /** Отдельный лимит на попытки входа: подбор пароля упирается в него. */
  readonly loginLimiter?: RateLimiter;
}

export interface App {
  readonly handle: (req: IncomingMessage, res: ServerResponse) => void;
  /** Прервать все идущие ответы: сервер останавливается. */
  abortAll(): void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const CHAT_ERROR_STATUS: Readonly<Record<ChatErrorCode, number>> = {
  empty: 400,
  bad_input: 400,
  too_long: 413,
  busy: 409,
  overloaded: 503,
};

export function createApp(deps: AppDeps): App {
  const controllers = new Set<AbortController>();
  const consoleAllowed =
    deps.consoleAccess ??
    ((req: IncomingMessage): boolean => deps.trustProxy !== true && isLoopbackAddress(req.socket.remoteAddress));
  const clientIp = (req: IncomingMessage): string => clientAddress(req, deps.trustProxy === true);
  const sessionId = (req: IncomingMessage): string | undefined => parseCookies(req.headers.cookie).get(SESSION_COOKIE);

  const directory =
    deps.staff ??
    new StaffDirectory(deps.managerPassword !== undefined && deps.managerPassword.length >= 8 ? [makeAccount("manager", "manager", deps.managerPassword)] : []);
  const tokens = deps.tokens ?? new TokenIssuer({ ttlSec: deps.sessionTtlSec });
  const tokenOf = (req: IncomingMessage): string | undefined => {
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer vx1.") ? header.slice("Bearer ".length) : parseCookies(req.headers.cookie).get(STAFF_COOKIE);
  };
  const staffCheck = (req: IncomingMessage): TokenCheck => tokens.verify(tokenOf(req));
  const roleOf = (req: IncomingMessage): Role => {
    const check = staffCheck(req);
    return check.ok ? check.claims.role : "client";
  };
  /** Роль в консоли: токен сотрудника, а на компьютере с сервером без входа это владелец. */
  const consoleRole = (req: IncomingMessage): Role => {
    const check = staffCheck(req);
    return check.ok ? check.claims.role : consoleAllowed(req) ? "owner" : "client";
  };
  const staffAllowed = (req: IncomingMessage): boolean => consoleAllowed(req) || staffCheck(req).ok;
  const deny = (req: IncomingMessage, what: string, role: Role, login: string | null): void => {
    deps.feed?.publish("deny", { what, role, login, ip: maskIp(clientIp(req)) });
  };
  const page =
    (file: string): Handler =>
    async (req, res) => {
      if (!(await serveStatic(req, res, deps.webDir, file))) {
        throw new HttpError(404, "not_found", "Страница не найдена.");
      }
    };

  const staff =
    (handler: Handler): Handler =>
    (req, res) =>
      staffAllowed(req)
        ? handler(req, res)
        : Promise.reject(
            isExpired(staffCheck(req))
              ? new HttpError(403, "token_expired", "Срок входа истёк. Войдите снова.")
              : new HttpError(403, "staff_only", "Нужен вход сотрудника."),
          );

  const beginTurn = (session: Session, message: unknown, role: Role): Turn => {
    session.role = role;
    try {
      return deps.chat.begin(session.conversation, message, session.tag, session.role);
    } catch (error) {
      if (error instanceof ChatError) {
        throw new HttpError(
          CHAT_ERROR_STATUS[error.code],
          error.code,
          error.message,
          error.code === "overloaded" ? { "retry-after": "30" } : {},
        );
      }
      throw error;
    }
  };

  const chat: Handler = async (req, res) => {
    if (!isSameOrigin(req)) {
      throw new HttpError(403, "bad_origin", "Запрос с другого сайта отклонён.");
    }
    if (!deps.ready) {
      throw new HttpError(503, "not_configured", "Ассистент пока не подключён к модели: на сервере не задан ключ API.");
    }
    const body = await readJson(req, JSON_LIMIT_BYTES);
    const message = isObject(body) ? body["message"] : undefined;
    const limit = deps.rateLimiter.hit(clientIp(req));
    if (!limit.ok) {
      throw new HttpError(
        429,
        "rate_limited",
        `Слишком много сообщений подряд. Попробуйте через ${formatWait(limit.retryAfterSec)}.`,
        { "retry-after": String(limit.retryAfterSec) },
      );
    }
    const { session } = deps.sessions.resolve(sessionId(req));
    const turn = beginTurn(session, message, roleOf(req));
    const controller = new AbortController();
    controllers.add(controller);
    // Клиент закрыл вкладку или нажал «Стоп»: прерываем запрос к модели, ответ не сохраняется.
    res.once("close", () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });
    try {
      const sse = new SseStream(res, {
        "set-cookie": serializeCookie(SESSION_COOKIE, session.id, {
          maxAgeSec: deps.sessionTtlSec,
          secure: deps.secureCookies,
        }),
      });
      sse.send("meta", { turn: turn.id, model: deps.publicInfo.assistant.model, prompt: deps.publicInfo.prompt.fingerprint });
      let thinking = false;
      const result = await turn.run(
        {
          onThinking: () => {
            if (!thinking) {
              thinking = true;
              sse.send("thinking", {});
            }
          },
          onText: (text) => {
            sse.send("delta", { text });
          },
          onFallback: (from, to) => {
            sse.send("fallback", { from, to });
          },
        },
        controller.signal,
      );
      if (result.outcome === "failed") {
        sse.send("error", { code: "model_error", message: result.errorMessage ?? "Не получилось получить ответ." });
      } else {
        sse.send("done", { turn: result.id, ...result.meta });
      }
      sse.end();
    } finally {
      turn.release();
      controllers.delete(controller);
    }
  };

  const reset: Handler = async (req, res) => {
    if (!isSameOrigin(req)) {
      throw new HttpError(403, "bad_origin", "Запрос с другого сайта отклонён.");
    }
    await readJson(req, JSON_LIMIT_BYTES);
    const session = deps.sessions.find(sessionId(req));
    if (session !== undefined && !session.conversation.reset()) {
      throw new HttpError(409, "busy", "Дождитесь окончания ответа или остановите его.");
    }
    sendJson(res, 200, { ok: true });
  };

  const history: Handler = (req, res) => {
    const session = deps.sessions.find(sessionId(req));
    const check = staffCheck(req);
    sendJson(res, 200, {
      messages: session?.conversation.transcript ?? [],
      role: check.ok ? check.claims.role : "client",
      staff: check.ok ? { login: check.claims.sub, role: check.claims.role, expiresAt: new Date(check.claims.exp * 1000).toISOString() } : null,
    });
    return Promise.resolve();
  };
  const login: Handler = async (req, res) => {
    if (!isSameOrigin(req)) {
      throw new HttpError(403, "bad_origin", "Запрос с другого сайта отклонён.");
    }
    const body = await readJson(req, JSON_LIMIT_BYTES);
    const loginKey = `login:${clientIp(req)}`;
    const limit = (deps.loginLimiter ?? deps.rateLimiter).hit(loginKey);
    if (!limit.ok) {
      throw new HttpError(429, "rate_limited", `Слишком много попыток входа. Попробуйте через ${formatWait(limit.retryAfterSec)}.`, {
        "retry-after": String(limit.retryAfterSec),
      });
    }
    if (directory.size === 0) {
      throw new HttpError(503, "login_disabled", "Вход для сотрудников не настроен: на сервере не заданы учётные записи.");
    }
    const fields = isObject(body) ? body : {};
    const loginName = typeof fields["login"] === "string" && fields["login"].trim() !== "" ? fields["login"] : "manager";
    const account = directory.verify(loginName, fields["password"]);
    if (account === null) {
      deps.feed?.publish("auth", { action: "login_failed", login: loginName.slice(0, 32), ip: maskIp(clientIp(req)) });
      throw new HttpError(401, "bad_password", "Неверный логин или пароль.");
    }
    (deps.loginLimiter ?? deps.rateLimiter).forgive(loginKey);
    const { token, claims } = tokens.issue(account.login, account.role);
    // Диалог посетителя не переходит в диалог сотрудника.
    deps.sessions.find(sessionId(req))?.conversation.reset();
    deps.feed?.publish("auth", { action: "login", login: account.login, role: account.role, ttlSec: tokens.ttlSec, ip: maskIp(clientIp(req)) });
    sendJson(res, 200, { role: account.role, roleLabel: ROLE_LABELS[account.role], login: account.login, expiresAt: new Date(claims.exp * 1000).toISOString() }, {
      "set-cookie": serializeCookie(STAFF_COOKIE, token, { maxAgeSec: tokens.ttlSec, secure: deps.secureCookies }),
    });
  };
  const logout: Handler = async (req, res) => {
    if (!isSameOrigin(req)) {
      throw new HttpError(403, "bad_origin", "Запрос с другого сайта отклонён.");
    }
    await readJson(req, JSON_LIMIT_BYTES);
    const check = staffCheck(req);
    if (check.ok) {
      tokens.revoke(check.claims);
      deps.feed?.publish("auth", { action: "logout", login: check.claims.sub, role: check.claims.role, ip: maskIp(clientIp(req)) });
    }
    const session = deps.sessions.find(sessionId(req));
    if (session !== undefined) {
      session.role = "client";
    }
    sendJson(res, 200, { role: "client" }, { "set-cookie": serializeCookie(STAFF_COOKIE, "", { maxAgeSec: 0, secure: deps.secureCookies }) });
  };
  const mcp: Handler = async (req, res) => {
    if (!isSameOrigin(req)) {
      throw new HttpError(403, "bad_origin", "Запрос с другого сайта отклонён.");
    }
    const body = await readJson(req, JSON_LIMIT_BYTES);
    if (deps.tools === undefined) {
      throw new HttpError(404, "not_found", "MCP не настроен.");
    }
    // Роль берётся из токена. Без токена MCP открыт только на компьютере, где запущен сервер, как менеджеру.
    const check = staffCheck(req);
    const role: Role = check.ok ? check.claims.role : "manager";
    const response = handleMcp(body, deps.tools, { role, unmask: (value) => value, now: Date.now() });
    if (response === null) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, response);
  };

  const crmAuth = async (req: IncomingMessage): Promise<{ bridge: CrmBridge; body: unknown }> => {
    if (deps.crm === undefined) {
      throw new HttpError(404, "not_found", "Подключение CRM не настроено: задайте VORONIX_CRM_KEY.");
    }
    const header = req.headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!passwordMatches(given, deps.crm.key)) {
      throw new HttpError(401, "bad_key", "Неверный ключ CRM.");
    }
    return { bridge: deps.crm.bridge, body: await readJson(req, CRM_LIMIT_BYTES) };
  };

  const crmStart: Handler = async (req, res) => {
    const { bridge, body } = await crmAuth(req);
    try {
      sendJson(res, 200, await bridge.start(parseCrmTurn(body)));
    } catch (error) {
      if (error instanceof CrmInputError) {
        throw new HttpError(400, "bad_input", error.message);
      }
      if (error instanceof CrmBusyError) {
        throw new HttpError(503, "overloaded", error.message);
      }
      throw error;
    }
  };

  const crmResult: Handler = async (req, res) => {
    const { bridge, body } = await crmAuth(req);
    const b = isObject(body) ? body : {};
    const { turnId, callId, content, isError } = b;
    if (typeof turnId !== "string" || typeof callId !== "string" || typeof content !== "string" || content.length > CRM_LIMIT_BYTES) {
      throw new HttpError(400, "bad_input", "Нужны turnId, callId и content.");
    }
    const next = bridge.submit(turnId, callId, { content, isError: isError === true });
    if (next === null) {
      throw new HttpError(404, "not_found", "Ход не найден или уже закончен.");
    }
    sendJson(res, 200, await next);
  };

  const live: Handler = (req, res) => {
    const feed = deps.feed;
    if (feed === undefined) {
      throw new HttpError(404, "not_found", "Лента не настроена.");
    }
    // Оператор видит ответы ассистента. Входы, выходы, выгрузки и отказы с адресами видят менеджер и владелец.
    const role = consoleRole(req);
    const visible = (event: { readonly kind: string }): boolean => event.kind === "turn" || role === "manager" || role === "owner";
    const sse = new SseStream(res, {}, 10_000);
    sse.send("hello", { events: feed.recent().filter(visible), watchers: feed.watchers + 1 });
    const stop = feed.subscribe((event) => {
      if (visible(event)) {
        sse.send("event", event);
      }
    });
    res.once("close", stop);
    return Promise.resolve();
  };

  const leads: Handler = (req, res) => {
    const check = staffCheck(req);
    const role: Role = check.ok ? check.claims.role : consoleAllowed(req) ? "owner" : "client";
    if (role !== "manager" && role !== "owner") {
      deny(req, "leads.csv", role, check.ok ? check.claims.sub : null);
      throw new HttpError(403, "forbidden", `Роль «${ROLE_LABELS[role]}» видит заявки, но не выгружает их. Выгрузка доступна менеджеру и владельцу.`);
    }
    if (deps.leadsCsv === undefined) {
      throw new HttpError(404, "not_found", "Выгрузка не настроена.");
    }
    const csv = "\ufeff" + deps.leadsCsv();
    deps.feed?.publish("auth", { action: "export", login: check.ok ? check.claims.sub : "localhost", role, ip: maskIp(clientIp(req)) });
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="voronix-leads.csv"',
      "cache-control": "no-store",
    });
    res.end(csv);
    return Promise.resolve();
  };

  const access: Handler = (req, res) => {
    const check = staffCheck(req);
    const role = consoleRole(req);
    sendJson(res, 200, {
      me: check.ok ? { login: check.claims.sub, role: check.claims.role, expiresAt: new Date(check.claims.exp * 1000).toISOString() } : { login: "localhost", role: "owner", expiresAt: null },
      tokenTtlSec: tokens.ttlSec,
      roles: ROLE_LABELS,
      matrix: deps.tools?.matrix() ?? [],
      // Логины и роли сотрудников видит только владелец: по ним подбирают пароли.
      accounts: role === "owner" ? directory.list() : [],
    });
    return Promise.resolve();
  };

  const json =
    (produce: () => unknown): Handler =>
    (_req, res) => {
      sendJson(res, 200, produce());
      return Promise.resolve();
    };

  const routes = new Map<string, Readonly<Record<string, Handler>>>([
    ["/", { GET: page("index.html") }],
    ["/chat", { GET: page("chat.html") }],
    ["/login", { GET: page("login.html") }],
    ["/console", { GET: page("console.html") }],
    ["/api/health", { GET: json(() => ({ ok: true })) }],
    ["/api/info", { GET: json(() => ({ ...deps.publicInfo, ready: deps.ready })) }],
    ["/api/history", { GET: history }],
    ["/api/chat", { POST: chat }],
    ["/api/reset", { POST: reset }],
    ["/api/login", { POST: login }],
    ["/api/logout", { POST: logout }],
    ["/mcp", { POST: staff(mcp) }],
    ["/v1/crm/turns", { POST: crmStart }],
    ["/v1/crm/turns/result", { POST: crmResult }],
    ["/console/api/overview", { GET: staff(json(() => deps.consoleInfo())) }],
    ["/console/api/turns", { GET: staff(json(() => ({ turns: deps.chat.log.list() }))) }],
    ["/console/api/live", { GET: staff(live) }],
    ["/console/api/leads.csv", { GET: staff(leads) }],
    ["/console/api/access", { GET: staff(access) }],
  ]);

  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    applySecurityHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (url.pathname.startsWith("/assets/")) {
      if (method !== "GET" && method !== "HEAD") {
        throw new HttpError(405, "method_not_allowed", "Метод не поддерживается.", { allow: "GET, HEAD" });
      }
      const assets = path.join(deps.webDir, "assets");
      if (!(await serveStatic(req, res, assets, url.pathname.slice("/assets/".length)))) {
        throw new HttpError(404, "not_found", "Файл не найден.");
      }
      return;
    }
    const route = routes.get(url.pathname);
    if (route === undefined) {
      throw new HttpError(404, "not_found", "Страница не найдена.");
    }
    const handler = route[method] ?? (method === "HEAD" ? route["GET"] : undefined);
    if (handler === undefined) {
      throw new HttpError(405, "method_not_allowed", "Метод не поддерживается.", {
        allow: Object.keys(route).join(", "),
      });
    }
    await handler(req, res);
  };

  return {
    handle: (req, res) => {
      dispatch(req, res).catch((error: unknown) => {
        fail(res, error);
      });
    },
    abortAll: () => {
      for (const controller of controllers) {
        controller.abort();
      }
    },
  };
}

function fail(res: ServerResponse, error: unknown): void {
  if (!(error instanceof HttpError)) {
    console.error("[server]", error);
  }
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  const http = error instanceof HttpError ? error : new HttpError(500, "internal", "Внутренняя ошибка сервера.");
  sendJson(
    res,
    http.status,
    { error: { code: http.code, message: http.message } },
    { ...http.headers, ...(http.status === 413 ? { connection: "close" } : {}) },
  );
}

function formatWait(seconds: number): string {
  return seconds < 60 ? `${seconds} с` : `${Math.ceil(seconds / 60)} мин`;
}

/** В ленте слежки адрес виден не целиком: 203.0.113.x. */
function maskIp(ip: string): string {
  if (ip.includes(".")) {
    return ip.split(".").slice(0, 3).join(".") + ".x";
  }
  return ip.split(":").slice(0, 3).join(":") + ":x";
}

function isExpired(check: TokenCheck): boolean {
  return !check.ok && (check.reason === "expired" || check.reason === "revoked");
}
