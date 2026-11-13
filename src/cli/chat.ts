import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { loadAppConfig, loadDotEnv } from "../config/index.ts";
import { loadSystemPrompt } from "../prompt/system-prompt.ts";
import { Assistant, toHistoryEntry } from "../llm/assistant.ts";
import { createClient } from "../llm/client.ts";
import { describeError } from "../llm/errors.ts";
import type { ChatMessage } from "../llm/request.ts";

const HELP = "Команды: /reset начать диалог заново, /info настройки, /exit выход.";

/**
 * Чат с ассистентом в терминале.
 *   npm run chat            ассистент VoroniX.ai с системным промптом
 *   npm run chat -- --raw   та же модель без системного промпта (для сравнения)
 */
async function main(): Promise<void> {
  loadDotEnv();
  const raw = process.argv.includes("--raw");
  const config = loadAppConfig();
  const system = raw ? null : loadSystemPrompt(config);
  const assistant = new Assistant(createClient(), config.assistant, system);
  const speaker = raw ? "Модель" : config.assistant.name;

  const info = (): string =>
    [
      `Модель: ${config.assistant.model}, усилие: ${config.assistant.effort}`,
      system === null
        ? "Системный промпт: выключен (режим --raw)"
        : `Системный промпт: ${system.id} ${system.version}, отпечаток ${system.fingerprint}`,
    ].join("\n");

  console.log(`\n${config.assistant.name}: чат в терминале\n${info()}\n${HELP}`);

  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
  const history: ChatMessage[] = [];
  rl.setPrompt("\nВы: ");
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (input === "") {
      rl.prompt();
      continue;
    }
    if (input === "/exit") {
      break;
    }
    if (input === "/reset") {
      history.length = 0;
      console.log("Диалог очищен.");
      rl.prompt();
      continue;
    }
    if (input === "/info") {
      console.log(info());
      rl.prompt();
      continue;
    }

    history.push({ role: "user", content: input });
    stdout.write(`\n${speaker}: `);
    try {
      const reply = await assistant.reply(history, {
        onText: (delta) => stdout.write(delta),
        onFallback: (from, to) => stdout.write(`\n[${from} отказала, ответ продолжает ${to}]\n`),
      });
      stdout.write("\n");
      if (reply.stopReason === "refusal") {
        console.log(`[Модель отказалась отвечать, категория: ${reply.refusalCategory ?? "не указана"}]`);
        history.pop();
      } else {
        if (reply.stopReason === "max_tokens") {
          console.log("[Ответ обрезан: достигнут лимит maxTokens]");
        }
        history.push(toHistoryEntry(reply));
      }
    } catch (error) {
      history.pop();
      console.log(`\n[Ошибка] ${describeError(error)}`);
    }
    rl.prompt();
  }
  rl.close();
}

main().catch((error: unknown) => {
  console.error(`[Ошибка] ${describeError(error)}`);
  process.exitCode = 1;
});
