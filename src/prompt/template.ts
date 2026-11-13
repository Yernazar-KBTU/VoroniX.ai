import { ConfigError } from "../config/errors.ts";

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** Имена всех {{переменных}} в шаблоне, без повторов, в порядке появления. */
export function listPlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Подставляет значения в {{переменные}}. Строгий режим: отсутствующая или лишняя
 * переменная это ошибка, чтобы в модель никогда не ушёл недособранный промпт.
 */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const used = listPlaceholders(template);
  const missing = used.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    throw new ConfigError(`Template is missing values for: ${missing.join(", ")}`);
  }
  const unused = Object.keys(values).filter((name) => !used.includes(name));
  if (unused.length > 0) {
    throw new ConfigError(`Values not used by the template: ${unused.join(", ")}`);
  }
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => values[name] ?? "");
  if (rendered.includes("{{") || rendered.includes("}}")) {
    throw new ConfigError("Rendered prompt still contains {{ or }}");
  }
  return rendered;
}
