import type { AppConfig, ServerConfig } from "../config/index.ts";
import type { SystemPrompt } from "../prompt/system-prompt.ts";
import { LAYERS, type Layer } from "../core/layers.ts";
import type { ChatService } from "../chat/service.ts";
import type { TurnStats } from "../chat/turn-log.ts";
import type { SessionStore } from "./sessions.ts";

/** Что видит любой посетитель: без текста промпта и без журнала. */
export interface PublicInfo {
  readonly assistant: { readonly name: string; readonly model: string; readonly effort: string };
  readonly prompt: { readonly version: string; readonly fingerprint: string };
  readonly languages: readonly string[];
  readonly layers: readonly Layer[];
  readonly limits: { readonly maxInputChars: number };
}

export function buildPublicInfo(config: AppConfig, system: SystemPrompt): PublicInfo {
  return {
    assistant: { name: config.assistant.name, model: config.assistant.model, effort: config.assistant.effort },
    prompt: { version: system.version, fingerprint: system.fingerprint },
    languages: config.product.assistantLanguages,
    layers: LAYERS,
    limits: { maxInputChars: config.server.maxInputChars },
  };
}

/** Данные консоли сотрудника: полный промпт, настройки, состояние сервера, статистика ответов. */
export interface ConsoleOverview {
  readonly assistant: {
    readonly name: string;
    readonly model: string;
    readonly effort: string;
    readonly maxTokens: number;
    readonly refusalFallback: boolean;
  };
  readonly prompt: {
    readonly id: string;
    readonly version: string;
    readonly fingerprint: string;
    readonly chars: number;
    readonly text: string;
  };
  readonly layers: readonly Layer[];
  readonly server: {
    readonly startedAt: string;
    readonly uptimeSec: number;
    readonly ready: boolean;
    readonly sessions: number;
    readonly activeTurns: number;
    readonly limits: ServerConfig;
  };
  readonly stats: TurnStats;
}

export interface ConsoleContext {
  readonly config: AppConfig;
  readonly system: SystemPrompt;
  readonly chat: ChatService;
  readonly sessions: SessionStore;
  readonly startedAt: number;
  readonly ready: boolean;
}

export function buildConsoleOverview(ctx: ConsoleContext): ConsoleOverview {
  const { config, system } = ctx;
  return {
    assistant: {
      name: config.assistant.name,
      model: config.assistant.model,
      effort: config.assistant.effort,
      maxTokens: config.assistant.maxTokens,
      refusalFallback: config.assistant.refusalFallback,
    },
    prompt: {
      id: system.id,
      version: system.version,
      fingerprint: system.fingerprint,
      chars: system.text.length,
      text: system.text,
    },
    layers: LAYERS,
    server: {
      startedAt: new Date(ctx.startedAt).toISOString(),
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      ready: ctx.ready,
      sessions: ctx.sessions.size,
      activeTurns: ctx.chat.activeTurns,
      limits: config.server,
    },
    stats: ctx.chat.log.stats(),
  };
}
