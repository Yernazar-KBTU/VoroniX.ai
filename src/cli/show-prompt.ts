import { loadAppConfig } from "../config/index.ts";
import { loadSystemPrompt } from "../prompt/system-prompt.ts";
import { describeError } from "../llm/errors.ts";

/** Печатает собранный системный промпт: удобно проверить, что именно уходит в модель. */
try {
  const prompt = loadSystemPrompt(loadAppConfig());
  console.log(`# ${prompt.id} ${prompt.version}, отпечаток ${prompt.fingerprint}, ${prompt.text.length} символов\n`);
  console.log(prompt.text);
} catch (error) {
  console.error(`[Ошибка] ${describeError(error)}`);
  process.exitCode = 1;
}
