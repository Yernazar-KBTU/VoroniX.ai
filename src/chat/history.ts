import type { ChatMessage } from "../llm/request.ts";

const THINKING_BLOCKS: ReadonlySet<string> = new Set(["thinking", "redacted_thinking"]);

/**
 * Держит историю в пределах maxMessages. Пока лимит не превышен, история только дописывается.
 *
 * Почему так: у Claude Opus 5.5 блок размышлений привязан ко всему, что было до него.
 * Если удалить старые сообщения, такие блоки API отклоняет (для новых аккаунтов это ошибка 400).
 * Поэтому при обрезке из оставшихся ответов убираем блоки размышлений, а текст сохраняем.
 * Режем с запасом, до половины лимита: следующие ходы снова идут без правок истории,
 * и кэш промпта (шаг 6) не сбрасывается на каждом сообщении.
 */
export function trimHistory(
  history: readonly ChatMessage[],
  maxMessages: number,
): { readonly messages: ChatMessage[]; readonly trimmed: boolean } {
  if (history.length <= maxMessages) {
    return { messages: [...history], trimmed: false };
  }
  let start = history.length - Math.max(1, Math.floor(maxMessages / 2));
  while (start < history.length - 1 && history[start]?.role !== "user") {
    start += 1;
  }
  return { messages: history.slice(start).map(stripThinking), trimmed: true };
}

export function stripThinking(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || typeof message.content === "string") {
    return message;
  }
  return { ...message, content: message.content.filter((block) => !THINKING_BLOCKS.has(block.type)) };
}
