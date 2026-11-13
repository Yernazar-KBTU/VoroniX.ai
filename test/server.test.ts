import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  HttpError,
  isLoopbackAddress,
  parseCookies,
  readJson,
  serializeCookie,
} from "../src/server/http.ts";
import { SessionStore } from "../src/server/sessions.ts";
import { RateLimiter } from "../src/server/rate-limit.ts";
import { parseSseText } from "../src/server/sse.ts";
import { parseServerConfig } from "../src/config/server.ts";
import { repoConfig } from "./helpers.ts";

function fakeRequest(body: string, headers: Record<string, string>): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), { headers }) as unknown as IncomingMessage;
}

const rejectsWith = async (promise: Promise<unknown>, status: number): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => error instanceof HttpError && error.status === status);
};

describe("куки", () => {
  it("разбирает заголовок Cookie, первое значение побеждает", () => {
    const cookies = parseCookies("a=1; vx_sid=abc ; broken; a=2");
    assert.equal(cookies.get("a"), "1");
    assert.equal(cookies.get("vx_sid"), "abc");
    assert.equal(parseCookies(undefined).size, 0);
  });

  it("кука сессии закрыта от скриптов и чужих сайтов", () => {
    const cookie = serializeCookie("vx_sid", "x", { maxAgeSec: 60, secure: false });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=60/);
    assert.doesNotMatch(cookie, /Secure/);
    assert.match(serializeCookie("vx_sid", "x", { maxAgeSec: 60, secure: true }), /; Secure$/);
  });
});

describe("isLoopbackAddress", () => {
  it("узнаёт только адреса этого компьютера", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.1.1"]) {
      assert.equal(isLoopbackAddress(address), true, address);
    }
    for (const address of ["10.0.0.5", "192.168.1.2", "::ffff:8.8.8.8", undefined]) {
      assert.equal(isLoopbackAddress(address), false, String(address));
    }
  });
});

describe("readJson", () => {
  it("читает JSON с правильным заголовком", async () => {
    const body = await readJson(fakeRequest('{"message":"привет"}', { "content-type": "application/json; charset=utf-8" }), 1024);
    assert.deepEqual(body, { message: "привет" });
  });

  it("отклоняет чужой тип, битый JSON и слишком большое тело", async () => {
    await rejectsWith(readJson(fakeRequest("{}", { "content-type": "text/plain" }), 1024), 415);
    await rejectsWith(readJson(fakeRequest("{oops", { "content-type": "application/json" }), 1024), 400);
    await rejectsWith(readJson(fakeRequest("x".repeat(2000), { "content-type": "application/json" }), 1024), 413);
    await rejectsWith(
      readJson(fakeRequest("{}", { "content-type": "application/json", "content-length": "99999" }), 1024),
      413,
    );
  });
});

describe("SessionStore", () => {
  it("создаёт сессию со случайным id и находит её снова", () => {
    const store = new SessionStore({ ttlMs: 60_000, maxSessions: 10 });
    const { session, created } = store.resolve(undefined);
    assert.equal(created, true);
    assert.match(session.id, /^[A-Za-z0-9_-]{32}$/);
    assert.match(session.tag, /^[0-9a-f]{8}$/);
    assert.equal(store.resolve(session.id).session, session);
    assert.equal(store.resolve("подделка").created, true);
  });

  it("забывает сессию после срока жизни", () => {
    let now = 0;
    const store = new SessionStore({ ttlMs: 1000, maxSessions: 10, now: () => now });
    const { session } = store.resolve(undefined);
    now = 999;
    assert.equal(store.find(session.id), session);
    now = 2500;
    assert.equal(store.find(session.id), undefined);
  });

  it("при переполнении вытесняет самую давнюю сессию", () => {
    let now = 0;
    const store = new SessionStore({ ttlMs: 60_000, maxSessions: 2, now: () => now });
    const first = store.resolve(undefined).session;
    now = 1;
    const second = store.resolve(undefined).session;
    now = 2;
    store.find(first.id);
    now = 3;
    store.resolve(undefined);
    assert.equal(store.size, 2);
    assert.equal(store.find(second.id), undefined);
    assert.equal(store.find(first.id), first);
  });
});

describe("RateLimiter", () => {
  it("пропускает limit сообщений за окно и говорит, сколько ждать", () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 2, windowMs: 10_000, now: () => now });
    assert.equal(limiter.hit("ip").ok, true);
    assert.equal(limiter.hit("ip").ok, true);
    const blocked = limiter.hit("ip");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.retryAfterSec, 10);
    assert.equal(limiter.hit("другой ip").ok, true);
    now = 10_001;
    assert.equal(limiter.hit("ip").ok, true);
  });
});

describe("parseSseText", () => {
  it("разбирает события и пропускает пинги", () => {
    const events = parseSseText(': ping\n\nevent: delta\ndata: {"text":"a"}\n\nevent: done\ndata: {}\n\n');
    assert.deepEqual(events, [
      { name: "delta", data: { text: "a" } },
      { name: "done", data: {} },
    ]);
  });
});

describe("config/server.json", () => {
  it("лимиты сервера читаются и проверяются", () => {
    const { server } = repoConfig();
    assert.ok(server.maxInputChars >= 500);
    assert.ok(server.rateLimit.messages > 0);
    assert.throws(() => parseServerConfig({ ...server, maxHistoryMessages: 1 }), /at least 2/);
    assert.throws(() => parseServerConfig({ ...server, rateLimit: { messages: 0, windowMinutes: 1 } }));
  });
});
