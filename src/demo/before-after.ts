import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadAppConfig, loadDotEnv } from "../config/index.ts";
import { DOCS_DIR } from "../config/paths.ts";
import { loadSystemPrompt } from "../prompt/system-prompt.ts";
import { Assistant, type Reply } from "../llm/assistant.ts";
import { createClient } from "../llm/client.ts";
import { describeError } from "../llm/errors.ts";
import { STEP1_QUESTIONS } from "./questions.ts";
import { renderMarkdown, type DemoAnswer, type DemoItem, type DemoRun } from "./report.ts";

function toAnswer(reply: Reply): DemoAnswer {
  return {
    text: reply.stopReason === "refusal" ? `[отказ модели: ${reply.refusalCategory ?? "без категории"}]` : reply.text,
    servedBy: reply.servedBy,
    stopReason: reply.stopReason,
    inputTokens: reply.inputTokens,
    outputTokens: reply.outputTokens,
  };
}

/** Прогоняет 6 вопросов через модель без промпта и с промптом, сохраняет отчёт в docs/demo. */
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadAppConfig();
  const system = loadSystemPrompt(config);
  const client = createClient();
  const raw = new Assistant(client, config.assistant, null);
  const voronix = new Assistant(client, config.assistant, system);

  const items: DemoItem[] = [];
  for (const [index, question] of STEP1_QUESTIONS.entries()) {
    console.log(`[${index + 1}/${STEP1_QUESTIONS.length}] ${question.topic}`);
    const history = [{ role: "user" as const, content: question.text }];
    const [before, after] = await Promise.all([raw.reply(history), voronix.reply(history)]);
    items.push({ question, before: toAnswer(before), after: toAnswer(after) });
  }

  const run: DemoRun = {
    generatedAt: new Date().toISOString(),
    model: config.assistant.model,
    effort: config.assistant.effort,
    prompt: { id: system.id, version: system.version, fingerprint: system.fingerprint },
    items,
  };
  const outDir = path.join(DOCS_DIR, "demo");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "step1-before-after.json"), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(path.join(outDir, "step1-before-after.md"), renderMarkdown(run));
  const total = items.reduce(
    (sum, item) => sum + item.before.inputTokens + item.before.outputTokens + item.after.inputTokens + item.after.outputTokens,
    0,
  );
  console.log(`Готово: docs/demo/step1-before-after.md (всего токенов: ${total})`);
}

main().catch((error: unknown) => {
  console.error(`[Ошибка] ${describeError(error)}`);
  process.exitCode = 1;
});
