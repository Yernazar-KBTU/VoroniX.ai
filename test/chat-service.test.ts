import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { ChatError, ChatService } from "../src/chat/service.ts";
import { Conversation } from "../src/chat/conversation.ts";
import { TurnLog, median } from "../src/chat/turn-log.ts";
import { trimHistory } from "../src/chat/history.ts";
import { toHistoryEntry } from "../src/llm/assistant.ts";
import type { ChatMessage } from "../src/llm/request.ts";
import { FakeEngine, deferred, fakeReply } from "./helpers.ts";

function setup(engine = new FakeEngine(), maxConcurrent = 2) {
  const log = new TurnLog(10);
  const chat = new ChatService(engine, {
    model: "claude-opus-5-5",
    maxInputChars: 50,
    maxHistoryMessages: 6,
    maxConcurrent,
    log,
  });
  return { engine, log, chat, conversation: new Conversation() };
}

describe("ChatService", () => {
  it("сохраняет вопрос и ответ, стримит текст и пишет в журнал только метрики", async () => {
    const { chat, conversation, log, engine } = setup();
    const deltas: string[] = [];
    const result = await chat.begin(conversation, "  Что умеет VoroniX?  ", "s1").run({ onText: (d) => deltas.push(d) });
    assert.equal(result.outcome, "answered");
    assert.equal(deltas.join(""), "Привет от VoroniX");
    assert.deepEqual(engine.calls[0], [{ role: "user", content: "Что умеет VoroniX?" }]);
    assert.equal(conversation.history.length, 2);
    assert.deepEqual(
      conversation.transcript.map((entry) => [entry.role, entry.text]),
      [
        ["user", "Что умеет VoroniX?"],
        ["assistant", "Привет от VoroniX"],
      ],
    );
    const record = log.list()[0];
    assert.ok(record);
    assert.equal(record.outcome, "answered");
    assert.equal(record.requestId, "req_test");
    assert.equal(record.inputChars, 18);
    assert.equal(JSON.stringify(log.list()).includes("Что умеет"), false, "текст вопроса не должен попадать в журнал");
    assert.equal(conversation.busy, false);
  });

  it("отклоняет пустое, слишком длинное и нетекстовое сообщение до обращения к модели", () => {
    const { chat, conversation, engine } = setup();
    const cases: [unknown, string][] = [
      ["   ", "empty"],
      ["x".repeat(51), "too_long"],
      [42, "bad_input"],
    ];
    for (const [input, code] of cases) {
      assert.throws(
        () => chat.begin(conversation, input, "s"),
        (error: unknown) => error instanceof ChatError && error.code === code,
      );
    }
    assert.equal(engine.calls.length, 0);
    assert.equal(conversation.busy, false);
  });

  it("не начинает второй ответ в том же диалоге, пока идёт первый", async () => {
    const gate = deferred<null>();
    const engine = new FakeEngine(async () => {
      await gate.promise;
      return fakeReply("Готово");
    });
    const { chat, conversation } = setup(engine);
    const first = chat.begin(conversation, "Первый", "s").run();
    assert.throws(
      () => chat.begin(conversation, "Второй", "s"),
      (error: unknown) => error instanceof ChatError && error.code === "busy",
    );
    gate.resolve(null);
    assert.equal((await first).outcome, "answered");
    assert.equal((await chat.begin(conversation, "Второй", "s").run()).outcome, "answered");
  });

  it("ограничивает число одновременных ответов на весь сервер", async () => {
    const gate = deferred<null>();
    const engine = new FakeEngine(async () => {
      await gate.promise;
      return fakeReply("Готово");
    });
    const { chat } = setup(engine, 1);
    const first = chat.begin(new Conversation(), "Один", "a").run();
    assert.throws(
      () => chat.begin(new Conversation(), "Два", "b"),
      (error: unknown) => error instanceof ChatError && error.code === "overloaded",
    );
    gate.resolve(null);
    await first;
    assert.equal(chat.activeTurns, 0);
  });

  it("release без run освобождает диалог", () => {
    const { chat, conversation } = setup();
    const turn = chat.begin(conversation, "Привет", "s");
    turn.release();
    turn.release();
    assert.equal(conversation.busy, false);
    assert.equal(chat.activeTurns, 0);
  });

  it("при отказе модели вопрос не остаётся в истории", async () => {
    const { chat, conversation } = setup(new FakeEngine(() => Promise.resolve(fakeReply("", "refusal"))));
    const result = await chat.begin(conversation, "Опасный вопрос", "s").run();
    assert.equal(result.outcome, "refused");
    assert.equal(conversation.history.length, 0);
  });

  it("при ошибке API клиент видит общий текст, а сотрудник подробности", async () => {
    const { chat, conversation, log } = setup(new FakeEngine(() => Promise.reject(new Error("секретная деталь 401"))));
    const result = await chat.begin(conversation, "Привет", "s").run();
    assert.equal(result.outcome, "failed");
    assert.equal(result.errorMessage, "Не получилось получить ответ. Попробуйте ещё раз.");
    assert.equal(log.list()[0]?.error, "секретная деталь 401");
    assert.equal(conversation.history.length, 0);
  });

  it("отмена запроса не сохраняет оборванный ответ", async () => {
    const engine = new FakeEngine(
      (_history, _handlers, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new Anthropic.APIUserAbortError());
          });
        }),
    );
    const { chat, conversation, log } = setup(engine);
    const controller = new AbortController();
    const pending = chat.begin(conversation, "Расскажи всё", "s").run({}, controller.signal);
    controller.abort();
    const result = await pending;
    assert.equal(result.outcome, "cancelled");
    assert.equal(conversation.history.length, 0);
    assert.equal(log.stats().byOutcome.cancelled, 1);
  });

  it("обрезанный по лимиту ответ сохраняется и помечается", async () => {
    const { chat, conversation } = setup(new FakeEngine(() => Promise.resolve(fakeReply("Длинный ответ", "max_tokens"))));
    const result = await chat.begin(conversation, "Расскажи", "s").run();
    assert.equal(result.outcome, "truncated");
    assert.equal(conversation.history.length, 2);
  });
});

describe("trimHistory", () => {
  const turn = (n: number): ChatMessage[] => [
    { role: "user", content: `вопрос ${n}` },
    toHistoryEntry(fakeReply(`ответ ${n}`)),
  ];

  it("пока лимит не превышен, история только дописывается", () => {
    const history = [...turn(1), ...turn(2)];
    const { messages, trimmed } = trimHistory(history, 6);
    assert.equal(trimmed, false);
    assert.deepEqual(messages, history);
  });

  it("режет с запасом, начинает с вопроса клиента и убирает блоки размышлений", () => {
    const history = [...turn(1), ...turn(2), ...turn(3), { role: "user", content: "вопрос 4" } as ChatMessage];
    const { messages, trimmed } = trimHistory(history, 6);
    assert.equal(trimmed, true);
    assert.ok(messages.length <= 3);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages.at(-1)?.content, "вопрос 4");
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        assert.ok(message.content.every((block) => block.type !== "thinking"));
      }
    }
  });
});

describe("median", () => {
  it("считает медиану для чётного и нечётного числа значений", () => {
    assert.equal(median([]), null);
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([1, 2, 3, 10]), 3);
  });
});
