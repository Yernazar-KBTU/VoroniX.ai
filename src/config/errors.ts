/** Ошибка в файлах конфигурации или шаблоне промпта. */
export class ConfigError extends Error {
  override name = "ConfigError";
}
