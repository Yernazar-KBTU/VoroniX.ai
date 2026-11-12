import Anthropic from "@anthropic-ai/sdk";
import { ConfigError } from "../config/errors.ts";

/** Понятное сообщение об ошибке на русском. Порядок проверок: от частного к общему. */
export function describeError(error: unknown): string {
  if (error instanceof ConfigError) {
    return `Ошибка конфигурации: ${error.message}`;
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "Ключ API не принят (401). Проверьте переменную ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "У ключа нет доступа к этой модели или функции (403).";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return "Модель не найдена (404). Проверьте поле model в config/assistant.json.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Слишком много запросов или закончился лимит (429). Подождите и повторите.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Запрос отклонён (400): ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Нет соединения с API Anthropic. Проверьте интернет и повторите.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Ошибка API Anthropic (${String(error.status)}): ${error.message}`;
  }
  if (error instanceof Error && error.message.includes("API key")) {
    return "Не найден ключ API. Задайте ANTHROPIC_API_KEY в окружении или в файле .env.";
  }
  return error instanceof Error ? error.message : String(error);
}
