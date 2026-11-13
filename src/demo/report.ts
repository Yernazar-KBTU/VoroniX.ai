import type { DemoQuestion } from "./questions.ts";

export interface DemoAnswer {
  readonly text: string;
  readonly servedBy: string;
  readonly stopReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface DemoItem {
  readonly question: DemoQuestion;
  readonly before: DemoAnswer;
  readonly after: DemoAnswer;
}

export interface DemoRun {
  readonly generatedAt: string;
  readonly model: string;
  readonly effort: string;
  readonly prompt: { readonly id: string; readonly version: string; readonly fingerprint: string };
  readonly items: readonly DemoItem[];
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

function tokens(answer: DemoAnswer): string {
  return `модель ${answer.servedBy}, токенов: ${answer.inputTokens} на вход, ${answer.outputTokens} на выход`;
}

/** Отчёт для защиты: вопрос, ответ «до», ответ «после». Ответы приводятся без правок. */
export function renderMarkdown(run: DemoRun): string {
  const lines = [
    "# Шаг 1: ответы до и после системного промпта",
    "",
    `Прогон: ${run.generatedAt}. Модель: ${run.model}, усилие: ${run.effort}.`,
    `Системный промпт: ${run.prompt.id} ${run.prompt.version}, отпечаток ${run.prompt.fingerprint}.`,
    "",
    "«До» это та же модель с теми же настройками, но без системного промпта. «После» это ассистент VoroniX.ai с промптом. Ответы приведены дословно, без правок.",
    "",
  ];
  run.items.forEach((item, index) => {
    lines.push(
      `## ${index + 1}. ${item.question.topic}`,
      "",
      `**Вопрос клиента:** ${item.question.text}`,
      "",
      `**Что должен сделать ассистент:** ${item.question.expected}`,
      "",
      "### До: модель без системного промпта",
      "",
      quote(item.before.text),
      "",
      `_${tokens(item.before)}_`,
      "",
      `### После: VoroniX.ai с промптом ${run.prompt.version}`,
      "",
      quote(item.after.text),
      "",
      `_${tokens(item.after)}_`,
      "",
    );
  });
  return lines.join("\n");
}
