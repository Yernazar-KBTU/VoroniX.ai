import path from "node:path";
import { existsSync } from "node:fs";
import { CONFIG_DIR, PROJECT_ROOT } from "./paths.ts";
import { readJsonFile } from "./validate.ts";
import { parseProductConfig, type ProductConfig } from "./product.ts";
import { parseAssistantConfig, type AssistantConfig } from "./assistant.ts";

export interface AppConfig {
  readonly product: ProductConfig;
  readonly assistant: AssistantConfig;
}

export function loadAppConfig(configDir: string = CONFIG_DIR): AppConfig {
  return {
    product: parseProductConfig(readJsonFile(path.join(configDir, "product.json"))),
    assistant: parseAssistantConfig(readJsonFile(path.join(configDir, "assistant.json"))),
  };
}

/** Подхватывает .env из корня проекта, если файл есть. Ключ никогда не хранится в коде. */
export function loadDotEnv(file: string = path.join(PROJECT_ROOT, ".env")): void {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

export type { ProductConfig } from "./product.ts";
export type { AssistantConfig, Effort } from "./assistant.ts";
