import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ConfigError } from "../config/errors.ts";
import { PROMPTS_DIR } from "../config/paths.ts";
import type { AppConfig } from "../config/index.ts";
import { parseFrontMatter } from "./front-matter.ts";
import { renderTemplate } from "./template.ts";
import { buildPromptVariables } from "./variables.ts";

/** Готовый к отправке системный промпт и его паспорт для логов. */
export interface SystemPrompt {
  readonly id: string;
  readonly version: string;
  readonly text: string;
  /** Первые 12 символов SHA-256 итогового текста: по нему видно, какой именно промпт ушёл в модель. */
  readonly fingerprint: string;
}

const VERSION_PATTERN = /^v\d+$/;

export function systemPromptPath(version: string, promptsDir: string = PROMPTS_DIR): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new ConfigError(`Prompt version must look like v1, v2: got "${version}"`);
  }
  return path.join(promptsDir, "system", `${version}.md`);
}

export function buildSystemPrompt(source: string, config: AppConfig, where = "system prompt"): SystemPrompt {
  const { meta, body } = parseFrontMatter(source, where);
  const id = meta["id"];
  const version = meta["version"];
  if (id === undefined || version === undefined) {
    throw new ConfigError(`${where}: front matter needs id and version`);
  }
  if (version !== config.assistant.promptVersion) {
    throw new ConfigError(
      `${where}: file says ${version}, but config/assistant.json asks for ${config.assistant.promptVersion}`,
    );
  }
  const text = renderTemplate(body, buildPromptVariables(config.product, config.assistant));
  const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 12);
  return { id, version, text, fingerprint };
}

export function loadSystemPrompt(config: AppConfig, promptsDir: string = PROMPTS_DIR): SystemPrompt {
  const file = systemPromptPath(config.assistant.promptVersion, promptsDir);
  return buildSystemPrompt(readFileSync(file, "utf8"), config, path.relative(process.cwd(), file));
}
