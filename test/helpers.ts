import { loadAppConfig, type AppConfig } from "../src/config/index.ts";

/** Настоящий конфиг из репозитория: тесты проверяют то, что реально уходит в модель. */
export function repoConfig(): AppConfig {
  return loadAppConfig();
}

export function withAssistant(config: AppConfig, patch: Partial<AppConfig["assistant"]>): AppConfig {
  return { ...config, assistant: { ...config.assistant, ...patch } };
}
