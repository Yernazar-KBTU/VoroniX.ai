import { ConfigError } from "../config/errors.ts";

export interface FrontMatterDocument {
  readonly meta: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Разбирает простой заголовок вида "---\nkey: value\n---" в начале файла. */
export function parseFrontMatter(source: string, where: string): FrontMatterDocument {
  const text = source.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    throw new ConfigError(`${where}: missing front matter`);
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new ConfigError(`${where}: front matter is not closed`);
  }
  const meta: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new ConfigError(`${where}: bad front matter line "${line}"`);
    }
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: text.slice(end + 5).trim() };
}
