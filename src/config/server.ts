import { ConfigError } from "./errors.ts";
import { asObject, readPositiveInt } from "./validate.ts";

/** Ограничения веб-сервера. Они защищают и клиентов, и счёт за API. */
export interface ServerConfig {
  /** Максимальная длина одного сообщения клиента, символов. */
  readonly maxInputChars: number;
  /** Сколько последних сообщений диалога отправлять модели. */
  readonly maxHistoryMessages: number;
  readonly sessionTtlMinutes: number;
  readonly maxSessions: number;
  /** Сколько ответов модели могут генерироваться одновременно на весь сервер. */
  readonly maxConcurrentReplies: number;
  /** Не больше messages сообщений за windowMinutes минут с одного адреса. */
  readonly rateLimit: { readonly messages: number; readonly windowMinutes: number };
  /** Сколько последних ответов хранит журнал консоли. */
  readonly turnLogSize: number;
}

const WHERE = "server";

export function parseServerConfig(raw: unknown): ServerConfig {
  const obj = asObject(raw, WHERE);
  const rateWhere = `${WHERE}.rateLimit`;
  const rate = asObject(obj["rateLimit"], rateWhere);
  const config: ServerConfig = {
    maxInputChars: readPositiveInt(obj, "maxInputChars", WHERE),
    maxHistoryMessages: readPositiveInt(obj, "maxHistoryMessages", WHERE),
    sessionTtlMinutes: readPositiveInt(obj, "sessionTtlMinutes", WHERE),
    maxSessions: readPositiveInt(obj, "maxSessions", WHERE),
    maxConcurrentReplies: readPositiveInt(obj, "maxConcurrentReplies", WHERE),
    rateLimit: {
      messages: readPositiveInt(rate, "messages", rateWhere),
      windowMinutes: readPositiveInt(rate, "windowMinutes", rateWhere),
    },
    turnLogSize: readPositiveInt(obj, "turnLogSize", WHERE),
  };
  if (config.maxHistoryMessages < 2) {
    throw new ConfigError(`${WHERE}.maxHistoryMessages: need at least 2 messages`);
  }
  return config;
}
