import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadAppConfig } from "../config/index.ts";
import { KNOWLEDGE_DIR, WEB_DIR } from "../config/paths.ts";
import { ResponseCache } from "../cache/response-cache.ts";
import { KnowledgeBase } from "../rag/knowledge.ts";
import { FAST_MODEL } from "../router/router.ts";
import { DemoCrm, ToolRegistry, crmTools } from "../tools/crm.ts";
import { loadSystemPrompt } from "../prompt/system-prompt.ts";
import { Assistant } from "../llm/assistant.ts";
import { createClient } from "../llm/client.ts";
import { ChatService, type ChatEngine } from "../chat/service.ts";
import { TurnLog } from "../chat/turn-log.ts";
import { createApp, type App } from "./app.ts";
import { buildConsoleOverview, buildPublicInfo } from "./info.ts";
import { RateLimiter } from "./rate-limit.ts";
import { SessionStore } from "./sessions.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface StartOptions {
  readonly host: string;
  readonly port: number;
  readonly env?: Env;
}

export interface RunningServer {
  readonly url: string;
  readonly ready: boolean;
  readonly app: App;
  readonly chat: ChatService;
  readonly crm: DemoCrm;
  readonly knowledge: KnowledgeBase;
  readonly cache: ResponseCache;
  close(): Promise<void>;
}

/** Есть ли ключ API в окружении. Сам ключ никуда не выводится. */
export function hasApiCredentials(env: Env): boolean {
  return [env["ANTHROPIC_API_KEY"], env["ANTHROPIC_AUTH_TOKEN"]].some(
    (value) => value !== undefined && value.trim() !== "",
  );
}

const missingKeyEngine: ChatEngine = {
  reply: () => Promise.reject(new Error("ANTHROPIC_API_KEY is not set")),
};

/** Собирает сервер из настоящих частей: конфиг, промпт, модель, сессии, журнал. */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const config = loadAppConfig();
  const system = loadSystemPrompt(config);
  const ready = hasApiCredentials(env);
  const engine: ChatEngine = ready ? new Assistant(createClient(), config.assistant, system) : missingKeyEngine;
  const limits = config.server;
  const knowledge = KnowledgeBase.load(KNOWLEDGE_DIR);
  const crm = new DemoCrm();
  const tools = new ToolRegistry(crmTools(crm));
  const cache = new ResponseCache({ ttlMs: 60 * 60_000, maxEntries: 500 });
  const password = env["VORONIX_MANAGER_PASSWORD"]?.trim() ?? "";
  const chat = new ChatService(engine, {
    model: config.assistant.model,
    maxInputChars: limits.maxInputChars,
    maxHistoryMessages: limits.maxHistoryMessages,
    maxConcurrent: limits.maxConcurrentReplies,
    log: new TurnLog(limits.turnLogSize),
    layers: {
      knowledge,
      tools,
      cache,
      fastModel: FAST_MODEL,
      guard: true,
      version: `${system.fingerprint}:${knowledge.version}`,
    },
  });
  const sessions = new SessionStore({ ttlMs: limits.sessionTtlMinutes * 60_000, maxSessions: limits.maxSessions });
  const startedAt = Date.now();
  const app = createApp({
    chat,
    sessions,
    rateLimiter: new RateLimiter({ limit: limits.rateLimit.messages, windowMs: limits.rateLimit.windowMinutes * 60_000 }),
    publicInfo: buildPublicInfo(config, system),
    consoleInfo: () => buildConsoleOverview({ config, system, chat, sessions, startedAt, ready }),
    webDir: WEB_DIR,
    ready,
    secureCookies: env["VORONIX_COOKIE_SECURE"] === "1",
    trustProxy: env["VORONIX_TRUST_PROXY"] === "1",
    sessionTtlSec: limits.sessionTtlMinutes * 60,
    tools,
    loginLimiter: new RateLimiter({ limit: 5, windowMs: 10 * 60_000 }),
    ...(password.length >= 8 ? { managerPassword: password } : {}),
  });
  const server = createServer(app.handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${displayHost(options.host)}:${port}`,
    ready,
    app,
    chat,
    crm,
    knowledge,
    cache,
    close: () => stop(server, app),
  };
}

function displayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    return "localhost";
  }
  return host.includes(":") ? `[${host}]` : host;
}

function stop(server: Server, app: App): Promise<void> {
  return new Promise((resolve) => {
    app.abortAll();
    server.close(() => {
      resolve();
    });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
    }, 3000).unref();
  });
}
