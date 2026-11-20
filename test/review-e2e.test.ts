import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppDeps } from "../src/server/app.ts";
import { buildConsoleOverview, buildPublicInfo } from "../src/server/info.ts";
import { RateLimiter } from "../src/server/rate-limit.ts";
import { SessionStore } from "../src/server/sessions.ts";
import { parseSseText } from "../src/server/sse.ts";
import { ChatService } from "../src/chat/service.ts";
import { TurnLog } from "../src/chat/turn-log.ts";
import { WEB_DIR, KNOWLEDGE_DIR } from "../src/config/paths.ts";
import { loadSystemPrompt } from "../src/prompt/system-prompt.ts";
import { StaffDirectory, makeAccount } from "../src/auth/staff.ts";
import { TokenIssuer } from "../src/auth/token.ts";
import { LiveFeed } from "../src/trace/live.ts";
import { ResponseCache } from "../src/cache/response-cache.ts";
import { KnowledgeBase } from "../src/rag/knowledge.ts";
import { FAST_MODEL } from "../src/router/router.ts";
import { DemoCrm, ToolRegistry, crmTools, leadsCsv } from "../src/tools/crm.ts";
import { CrmBridge } from "../src/crm/bridge.ts";
import { FakeEngine, fakeReply, repoConfig } from "./helpers.ts";

/**
 * Проверка Stage 4/6/7 через настоящий HTTP-сервер со всеми слоями, как их собирает bootstrap:
 * личные входы и роли, кэш по смыслу, лента времени и живая лента, мост к CRM.
 */
const config = repoConfig();
const system = loadSystemPrompt(config);
const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
});

async function boot(engine: FakeEngine, patch: Partial<AppDeps> = {}, bridgeEngine?: FakeEngine) {
  const knowledge = KnowledgeBase.load(KNOWLEDGE_DIR);
  const crm = new DemoCrm();
  const tools = new ToolRegistry(crmTools(crm));
  const cache = new ResponseCache({ ttlMs: 60_000, maxEntries: 50, weigh: (t) => knowledge.idf(t) });
  const feed = new LiveFeed();
  const chat = new ChatService(engine, {
    model: "claude-opus-5-5",
    maxInputChars: 500,
    maxHistoryMessages: 10,
    maxConcurrent: 4,
    log: new TurnLog(30),
    layers: { knowledge, tools, cache, fastModel: FAST_MODEL, guard: true, version: "v-test" },
  });
  chat.log.subscribe((record) => feed.turn(record));
  tools.onDeny = (name, role) => feed.publish("deny", { what: `tool:${name}`, role, login: null, ip: null });
  const sessions = new SessionStore({ ttlMs: 60_000, maxSessions: 20 });
  const tokens = new TokenIssuer({ ttlSec: 60 });
  const staff = new StaffDirectory([
    makeAccount("olga", "owner", "owner-pass-12"),
    makeAccount("dana", "manager", "manager-pass-1"),
    makeAccount("aliya", "operator", "operator-pass-1"),
  ]);
  const crmKey = "k".repeat(20);
  const bridge =
    bridgeEngine === undefined
      ? undefined
      : new CrmBridge({ makeEngine: () => bridgeEngine, log: chat.log, mainModel: "claude-opus-5-5", fastModel: FAST_MODEL, toolTimeoutMs: 2_000 });
  const app = createApp({
    chat,
    sessions,
    rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }),
    loginLimiter: new RateLimiter({ limit: 5, windowMs: 600_000 }),
    publicInfo: buildPublicInfo(config, system),
    consoleInfo: () => buildConsoleOverview({ config, system, chat, sessions, startedAt: Date.now(), ready: true }),
    webDir: WEB_DIR,
    ready: true,
    secureCookies: false,
    sessionTtlSec: 60,
    consoleAccess: () => false,
    tools,
    staff,
    tokens,
    feed,
    leadsCsv: () => leadsCsv(crm),
    ...(bridge === undefined ? {} : { crm: { bridge, key: crmKey } }),
    ...patch,
  });
  const server = createServer(app.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  return { base, feed, chat, crmKey };
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const cookieOf = (r: Response): string => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const login = async (base: string, who: string, password: string): Promise<string> => cookieOf(await post(base, "/api/login", { login: who, password }));

async function ask(base: string, message: string, cookie = ""): Promise<{ cookie: string; done: Record<string, unknown> | undefined; text: string }> {
  const res = await post(base, "/api/chat", { message }, cookie === "" ? {} : { cookie });
  const events = parseSseText(await res.text());
  const done = events.find((e) => e.name === "done")?.data as Record<string, unknown> | undefined;
  const text = events.filter((e) => e.name === "delta").map((e) => (e.data as { text: string }).text).join("");
  const session = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { cookie: cookie === "" ? session : cookie, done, text };
}

describe("Stage 4: роли и инструменты в живом чате", () => {
  it("модель получает инструменты по роли, а выгрузку оператору сервер отклоняет сам", async () => {
    const seen: Record<string, string[]> = {};
    let denied: string | null = null;
    let label = "client";
    const engine = new FakeEngine(async (_h, _handlers, options) => {
      seen[label] = (options.tools?.definitions ?? []).map((d) => d.name);
      if (label === "operator") {
        const result = await options.tools?.execute("export_leads", {});
        denied = result?.isError === true ? "denied" : "allowed";
      }
      return fakeReply("ок");
    });
    const { base } = await boot(engine);
    label = "client";
    await ask(base, "Запишите меня на стрижку");
    label = "operator";
    const op = await login(base, "aliya", "operator-pass-1");
    await ask(base, "Покажи заявки", op);
    label = "manager";
    const mg = await login(base, "dana", "manager-pass-1");
    await ask(base, "Покажи заявки", mg);
    assert.ok(!seen["client"]?.includes("list_leads"), "клиенту нельзя читать заявки");
    assert.ok(seen["operator"]?.includes("list_leads"), "оператор видит заявки");
    assert.ok(!seen["operator"]?.includes("export_leads"), "оператору не показывают выгрузку");
    assert.ok(seen["manager"]?.includes("export_leads"), "менеджеру выгрузка доступна");
    assert.equal(denied, "denied", "даже если модель попросит export_leads, сервер откажет оператору");
  });

  it("токен с истёкшим сроком перестаёт работать и в чате: роль падает до клиента", async () => {
    let now = 0;
    const tokens = new TokenIssuer({ ttlSec: 30, now: () => now });
    const roles: string[] = [];
    const engine = new FakeEngine((_h, _handlers, options) => {
      roles.push((options.tools?.definitions ?? []).some((d) => d.name === "list_leads") ? "staff" : "client");
      return Promise.resolve(fakeReply("ок"));
    });
    const { base } = await boot(engine, { tokens });
    const op = await login(base, "aliya", "operator-pass-1");
    await ask(base, "Покажи заявки", op);
    now += 31_000;
    assert.equal((await fetch(base + "/console/api/turns", { headers: { cookie: op } })).status, 403);
    await ask(base, "Покажи заявки ещё раз", op);
    assert.deepEqual(roles, ["staff", "client"]);
  });

  it("оператор не видит список учётных записей и ленту входов", async () => {
    const { base } = await boot(new FakeEngine());
    const op = await login(base, "aliya", "operator-pass-1");
    const own = (await (await fetch(base + "/console/api/access", { headers: { cookie: op } })).json()) as { accounts: { login: string }[]; me: { role: string } };
    assert.equal(own.me.role, "operator");
    assert.deepEqual(own.accounts, [], "учётные записи видит только владелец");
    const owner = await login(base, "olga", "owner-pass-12");
    const all = (await (await fetch(base + "/console/api/access", { headers: { cookie: owner } })).json()) as { accounts: { login: string }[] };
    assert.deepEqual(all.accounts.map((a) => a.login).sort(), ["aliya", "dana", "olga"]);
  });

  it("вход нового сотрудника не наследует диалог, а выход чистит и отзывает токен", async () => {
    const engine = new FakeEngine();
    const { base } = await boot(engine);
    const visitor = await ask(base, "Привет, я посетитель");
    const res = await post(base, "/api/login", { login: "aliya", password: "operator-pass-1" }, { cookie: visitor.cookie });
    const staffCookie = cookieOf(res);
    const merged = `${visitor.cookie}; ${staffCookie}`;
    const history = (await (await fetch(base + "/api/history", { headers: { cookie: merged } })).json()) as { messages: unknown[]; role: string };
    assert.equal(history.role, "operator");
    assert.equal(history.messages.length, 0, "диалог посетителя не переходит сотруднику");
  });

  it("подбор пароля упирается в лимит входа, правильный вход потом работает", async () => {
    const { base } = await boot(new FakeEngine());
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await post(base, "/api/login", { login: "dana", password: `wrong-pass-${String(i)}` })).status, 401);
    }
    assert.equal((await post(base, "/api/login", { login: "dana", password: "manager-pass-1" })).status, 429);
  });
});

describe("Stage 6: кэш по смыслу в живом чате", () => {
  it("второй посетитель с похожим вопросом получает ответ из кэша без вызова модели", async () => {
    const engine = new FakeEngine(() => Promise.resolve(fakeReply("VoroniX отвечает клиентам и записывает на услуги.")));
    const { base } = await boot(engine);
    const first = await ask(base, "Что умеет VoroniX?");
    assert.notEqual(first.done?.["cached"], true);
    const second = await ask(base, "Какие функции у VoroniX?");
    assert.equal(engine.calls.length, 1, "модель вызвана один раз");
    assert.equal(second.done?.["cached"], true);
    assert.equal((second.done?.["cacheMatch"] as { kind: string }).kind, "semantic");
    assert.match(second.text, /записывает/);
    const different = await ask(base, "Сколько стоит тариф Pro?");
    assert.equal(engine.calls.length, 2, "другой вопрос идёт в модель");
    assert.notEqual(different.done?.["cached"], true);
  });

  it("сотрудники и вопросы с личными данными в кэш не попадают", async () => {
    const engine = new FakeEngine(() => Promise.resolve(fakeReply("ответ")));
    const { base } = await boot(engine);
    const op = await login(base, "aliya", "operator-pass-1");
    await ask(base, "Что умеет VoroniX?", op);
    const visitor = await ask(base, "Что умеет VoroniX?");
    assert.equal(visitor.done?.["cached"] === true, false, "ответ сотруднику не раздаётся посетителям");
    await ask(base, "Мой телефон +7 701 555 12 34, что умеет VoroniX?");
    const again = await ask(base, "Мой телефон +7 701 555 12 34, что умеет VoroniX?");
    assert.equal(again.done?.["cached"] === true, false, "вопрос с телефоном не кэшируется");
  });
});

describe("Stage 7: лента времени и живая лента", () => {
  it("в журнале у ответа есть шаги с миллисекундами, в ленте есть цена, а кэш-ответ стоит 0", async () => {
    const engine = new FakeEngine(() => Promise.resolve(fakeReply("VoroniX отвечает клиентам.")));
    const { base, feed } = await boot(engine);
    await ask(base, "Что умеет VoroniX?");
    await ask(base, "Какие функции у VoroniX?");
    const owner = await login(base, "olga", "owner-pass-12");
    const turns = ((await (await fetch(base + "/console/api/turns", { headers: { cookie: owner } })).json()) as { turns: { trace?: { name: string; ms: number }[]; cached?: boolean }[] }).turns;
    assert.equal(turns.length, 2);
    const paid = turns.find((t) => t.cached !== true);
    const names = (paid?.trace ?? []).map((s) => s.name);
    for (const step of ["guard", "cache", "llm"]) {
      assert.ok(names.some((n) => n.startsWith(step)), `в ленте времени нет шага ${step}: ${names.join(",")}`);
    }
    assert.ok((paid?.trace ?? []).every((s) => typeof s.ms === "number" && s.ms >= 0));
    const events = feed.recent().filter((e) => e.kind === "turn");
    assert.equal(events.length, 2);
    const costs = events.map((e) => e.data["costUsd"] as number | null);
    assert.ok((costs[0] ?? 0) > 0, "платный ответ имеет цену");
    assert.equal(costs[1], 0, "ответ из кэша бесплатный");
  });

  it("живая лента отдаёт историю и новые события по SSE только вошедшему сотруднику", async () => {
    const engine = new FakeEngine(() => Promise.resolve(fakeReply("ответ")));
    const { base } = await boot(engine);
    assert.equal((await fetch(base + "/console/api/live")).status, 403);
    const owner = await login(base, "olga", "owner-pass-12");
    const ctl = new AbortController();
    const res = await fetch(base + "/console/api/live", { headers: { cookie: owner }, signal: ctl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body?.getReader();
    assert.ok(reader);
    let buffer = "";
    const read = async (until: RegExp): Promise<void> => {
      const decoder = new TextDecoder();
      const deadline = Date.now() + 3_000;
      while (!until.test(buffer) && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value);
      }
    };
    await read(/event: hello/);
    assert.match(buffer, /event: hello/);
    await ask(base, "Что умеет VoroniX?");
    await read(/event: event\ndata: \{[^\n]*"kind":"turn"/);
    assert.match(buffer, /"kind":"turn"/);
    ctl.abort();
  });
});

describe("подключение к CRM", () => {
  const turnBody = (text: string) => ({
    conversationId: "tenant-1:conv-9",
    system: "You are the assistant of Barber One.",
    messages: [{ role: "user", content: `Client: ${text}` }],
    tools: [{ name: "create_appointment", description: "Book", input_schema: { type: "object", properties: { phone: { type: "string" } }, required: ["phone"] } }],
  });

  it("ключ обязателен, ход идёт через инструмент CRM и заканчивается ответом", async () => {
    const bridgeEngine = new FakeEngine(async (_h, _handlers, options) => {
      const result = await options.tools?.execute("create_appointment", { phone: "+7 701 555 12 34" });
      return fakeReply(result?.isError === true ? "ошибка" : "Записала вас на завтра.");
    });
    const { base, crmKey } = await boot(new FakeEngine(), {}, bridgeEngine);
    assert.equal((await post(base, "/v1/crm/turns", turnBody("Запишите меня"))).status, 401);
    assert.equal((await post(base, "/v1/crm/turns", turnBody("Запишите меня"), { authorization: "Bearer wrong-key-wrong-key" })).status, 401);
    const auth = { authorization: `Bearer ${crmKey}` };
    const start = (await (await post(base, "/v1/crm/turns", turnBody("Запишите меня, +7 701 555 12 34"), auth)).json()) as { status: string; turnId: string; call: { id: string; name: string } };
    assert.equal(start.status, "tool");
    assert.equal(start.call.name, "create_appointment");
    const end = (await (await post(base, "/v1/crm/turns/result", { turnId: start.turnId, callId: start.call.id, content: '{"ok":true}', isError: false }, auth)).json()) as { status: string; text?: string; outcome?: string };
    assert.equal(end.status, "done");
    assert.equal(end.outcome, "answered");
    assert.match(end.text ?? "", /Записала/);
    assert.equal((await post(base, "/v1/crm/turns/result", { turnId: start.turnId, callId: start.call.id, content: "{}" }, auth)).status, 404, "закрытый ход повторно не принимается");
  });

  it("ходы CRM видны в ленте слежки с ценой", async () => {
    const bridgeEngine = new FakeEngine(() => Promise.resolve(fakeReply("Здравствуйте!")));
    const { base, crmKey, feed } = await boot(new FakeEngine(), {}, bridgeEngine);
    const res = await post(base, "/v1/crm/turns", turnBody("Здравствуйте"), { authorization: `Bearer ${crmKey}` });
    assert.equal(res.status, 200);
    assert.ok(feed.recent().some((e) => e.kind === "turn"), "ход CRM попал в живую ленту");
  });
});
