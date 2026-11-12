import type Anthropic from "@anthropic-ai/sdk";
import { loadAppConfig, type AppConfig } from "../src/config/index.ts";
import { summarizeReply, type Reply, type ReplyHandlers, type ReplyOptions } from "../src/llm/assistant.ts";
import type { ChatMessage } from "../src/llm/request.ts";
import type { ChatEngine } from "../src/chat/service.ts";

/** Настоящий конфиг из репозитория: тесты проверяют то, что реально уходит в модель. */
export function repoConfig(): AppConfig {
  return loadAppConfig();
}

export function withAssistant(config: AppConfig, patch: Partial<AppConfig["assistant"]>): AppConfig {
  return { ...config, assistant: { ...config.assistant, ...patch } };
}

/** Сообщение в формате API: блок размышлений с подписью и текст, как у Claude Opus 5.5. */
export function fakeMessage(
  text: string,
  stopReason: Anthropic.Beta.Messages.BetaMessage["stop_reason"] = "end_turn",
): Anthropic.Beta.Messages.BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig-test" },
      { type: "text", text, citations: null },
    ],
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  } as unknown as Anthropic.Beta.Messages.BetaMessage;
}

export function fakeReply(
  text: string,
  stopReason: Anthropic.Beta.Messages.BetaMessage["stop_reason"] = "end_turn",
): Reply {
  return { ...summarizeReply(fakeMessage(text, stopReason)), requestId: "req_test", timing: { firstTextMs: 5, totalMs: 9 } };
}

type Responder = (history: readonly ChatMessage[], handlers: ReplyHandlers, options: ReplyOptions) => Promise<Reply>;

const streamHello: Responder = (_history, handlers) => {
  handlers.onThinking?.();
  handlers.onText?.("Привет");
  handlers.onText?.(" от VoroniX");
  return Promise.resolve(fakeReply("Привет от VoroniX"));
};

/** Подделка модели: без сети, записывает, какую историю ей прислали. */
export class FakeEngine implements ChatEngine {
  readonly calls: ChatMessage[][] = [];
  respond: Responder;

  constructor(respond: Responder = streamHello) {
    this.respond = respond;
  }

  reply(history: readonly ChatMessage[], handlers: ReplyHandlers = {}, options: ReplyOptions = {}): Promise<Reply> {
    this.calls.push([...history]);
    return this.respond(history, handlers, options);
  }
}

/** Промис, который тест завершает сам: так проверяется «ответ ещё идёт». */
export function deferred<T>(): { readonly promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
