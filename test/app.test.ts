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
import { WEB_DIR } from "../src/config/paths.ts";
import { loadSystemPrompt } from "../src/prompt/system-prompt.ts";
import { FakeEngine, deferred, fakeReply, repoConfig } from "./helpers.ts";

const config = repoConfig();
const system = loadSystemPrompt(config);
const closers: (() => Promise<void>)[] = [];
after(async () => {
  await Promise.all(closers.map((close) => close()));
});

async function start(engine = new FakeEngine(), patch: Partial<AppDeps> = {}) {
  const log = new TurnLog(20);
  const chat = new ChatService(engine, { model: "claude-opus-5-5", maxInputChars: 100, maxHistoryMessages: 10, maxConcurrent: 4, log });
  const sessions = new SessionStore({ ttlMs: 60_000, maxSessions: 10 });
  const app = createApp({
    chat,
    sessions,
    rateLimiter: new RateLimiter({ limit: 100, windowMs: 60_000 }),
    publicInfo: buildPublicInfo(config, system),
    consoleInfo: () => buildConsoleOverview({ config, system, chat, sessions, startedAt: Date.now(), ready: true }),
    webDir: WEB_DIR,
    ready: true,
    secureCookies: false,
    sessionTtlSec: 60,
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
  return { base, engine, log };
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const cookieOf = (response: Response): string => (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

describe("веб-сервер", () => {
  it("отдаёт страницы и файлы с защитными заголовками и не выпускает за папку web", async () => {
    const { base } = await start();
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(await page.text(), /VoroniX\.ai/);
    assert.equal((await fetch(base + "/assets/app.css")).status, 200);
    assert.equal((await fetch(base + "/assets/..%2f..%2fpackage.json")).status, 404);
    assert.equal((await fetch(base + "/nope")).status, 404);
    const wrongMethod = await fetch(base + "/api/chat");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
  });

  it("/api/info показывает модель, версию промпта и 7 слоёв, из них включён первый", async () => {
    const { base } = await start();
    const info = (await (await fetch(base + "/api/info")).json()) as {
      ready: boolean;
      assistant: { model: string };
      prompt: { fingerprint: string };
      layers: { step: number; status: string }[];
    };
    assert.equal(info.ready, true);
    assert.equal(info.assistant.model, config.assistant.model);
    assert.equal(info.prompt.fingerprint, system.fingerprint);
    assert.equal(info.layers.length, 7);
    assert.deepEqual(
      info.layers.filter((layer) => layer.status === "active").map((layer) => layer.step),
      [1],
    );
  });

  it("чат стримит ответ событиями и помнит диалог по куке", async () => {
    const { base, engine } = await start();
    const first = await post(base, "/api/chat", { message: "Привет" });
    assert.equal(first.status, 200);
    assert.match(first.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(first.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
    const events = parseSseText(await first.text());
    assert.deepEqual(
      events.map((event) => event.name),
      ["meta", "thinking", "delta", "delta", "done"],
    );
    const done = events.at(-1)?.data as { outcome: string; requestId: string };
    assert.equal(done.outcome, "answered");
    assert.equal(done.requestId, "req_test");

    const cookie = cookieOf(first);
    const history = (await (await fetch(base + "/api/history", { headers: { cookie } })).json()) as {
      messages: { role: string; text: string }[];
    };
    assert.deepEqual(
      history.messages.map((m) => m.role),
      ["user", "assistant"],
    );
    await (await post(base, "/api/chat", { message: "А ещё?" }, { cookie })).text();
    assert.equal(engine.calls[1]?.length, 3, "второй вопрос уходит в модель вместе с первым ответом");
  });

  it("отклоняет плохие запросы до обращения к модели", async () => {
    const { base, engine } = await start();
    const wrongType = await fetch(base + "/api/chat", { method: "POST", body: "message=hi", headers: { "content-type": "text/plain" } });
    assert.equal(wrongType.status, 415);
    assert.equal((await post(base, "/api/chat", { message: "hi" }, { origin: "https://evil.example" })).status, 403);
    const empty = await post(base, "/api/chat", { message: "   " });
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as { error: { code: string } }).error.code, "empty");
    assert.equal((await post(base, "/api/chat", { message: "x".repeat(101) })).status, 413);
    assert.equal(engine.calls.length, 0);
  });

  it("второй вопрос, пока идёт ответ, получает 409", async () => {
    const gate = deferred<null>();
    const engine = new FakeEngine(async () => {
      await gate.promise;
      return fakeReply("Готово");
    });
    const { base } = await start(engine);
    const first = await post(base, "/api/chat", { message: "Первый" });
    const cookie = cookieOf(first);
    const second = await post(base, "/api/chat", { message: "Второй" }, { cookie });
    assert.equal(second.status, 409);
    gate.resolve(null);
    assert.match(await first.text(), /event: done/);
  });

  it("лимит частоты отвечает 429 с Retry-After", async () => {
    const { base } = await start(new FakeEngine(), { rateLimiter: new RateLimiter({ limit: 1, windowMs: 60_000 }) });
    await (await post(base, "/api/chat", { message: "Раз" })).text();
    const blocked = await post(base, "/api/chat", { message: "Два" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
  });

  it("без ключа API страница работает, а чат честно отвечает 503", async () => {
    const { base, engine } = await start(new FakeEngine(), { ready: false });
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal(((await (await fetch(base + "/api/info")).json()) as { ready: boolean }).ready, false);
    assert.equal((await post(base, "/api/chat", { message: "Привет" })).status, 503);
    assert.equal(engine.calls.length, 0);
  });

  it("консоль открыта только локально и не показывает текст сообщений", async () => {
    const local = await start();
    await (await post(local.base, "/api/chat", { message: "Мой номер +7 701 000 00 00" })).text();
    const overview = (await (await fetch(local.base + "/console/api/overview")).json()) as { prompt: { text: string } };
    assert.equal(overview.prompt.text, system.text);
    const turns = await (await fetch(local.base + "/console/api/turns")).text();
    assert.match(turns, /"outcome":"answered"/);
    assert.doesNotMatch(turns, /701/);

    const remote = await start(new FakeEngine(), { consoleAccess: () => false });
    assert.equal((await fetch(remote.base + "/console/api/turns")).status, 403);
    assert.equal((await fetch(remote.base + "/console/api/overview")).status, 403);
    assert.equal((await fetch(remote.base + "/console")).status, 403);
  });

  it("новый диалог очищает историю", async () => {
    const { base } = await start();
    const first = await post(base, "/api/chat", { message: "Привет" });
    await first.text();
    const cookie = cookieOf(first);
    assert.equal((await post(base, "/api/reset", {}, { cookie })).status, 200);
    const history = (await (await fetch(base + "/api/history", { headers: { cookie } })).json()) as { messages: unknown[] };
    assert.equal(history.messages.length, 0);
  });
});
