import { loadDotEnv } from "../config/index.ts";
import { describeError } from "../llm/errors.ts";
import { startServer } from "./bootstrap.ts";

/**
 * Веб-сервер VoroniX.ai: чат для клиентов и консоль сотрудника.
 *   npm start            http://127.0.0.1:3000
 *   HOST, PORT           адрес и порт (по умолчанию 127.0.0.1 и 3000)
 */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 3000;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT должен быть целым числом от 1 до 65535, получено "${raw}"`);
  }
  return port;
}

async function main(): Promise<void> {
  loadDotEnv();
  const host = process.env["HOST"]?.trim() ?? "";
  const server = await startServer({ host: host === "" ? "127.0.0.1" : host, port: parsePort(process.env["PORT"]) });
  console.log(`VoroniX.ai запущен: ${server.url}`);
  console.log(`Консоль сотрудника: ${server.url}/console (открывается только на этом компьютере)`);
  if (!server.ready) {
    console.warn("Ключ API не найден: чат будет отвечать 503. Задайте ANTHROPIC_API_KEY в .env и перезапустите.");
  }
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log("Останавливаю сервер...");
    void server.close().then(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(`[Ошибка] ${describeError(error)}`);
  process.exitCode = 1;
});
