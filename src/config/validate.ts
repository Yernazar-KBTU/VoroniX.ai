import { readFileSync } from "node:fs";
import { ConfigError } from "./errors.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown, where: string): JsonObject {
  if (!isObject(value)) {
    throw new ConfigError(`${where}: expected an object`);
  }
  return value;
}

export function readString(obj: JsonObject, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${where}.${key}: expected a non-empty string`);
  }
  return value.trim();
}

export function readOptionalString(obj: JsonObject, key: string, where: string): string | undefined {
  if (obj[key] === undefined) {
    return undefined;
  }
  return readString(obj, key, where);
}

export function readBoolean(obj: JsonObject, key: string, where: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw new ConfigError(`${where}.${key}: expected true or false`);
  }
  return value;
}

export function readPositiveInt(obj: JsonObject, key: string, where: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${where}.${key}: expected a positive integer`);
  }
  return value;
}

export function readArray(obj: JsonObject, key: string, where: string): readonly unknown[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${where}.${key}: expected a non-empty array`);
  }
  return value as readonly unknown[];
}

export function readStringArray(obj: JsonObject, key: string, where: string): readonly string[] {
  return readArray(obj, key, where).map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ConfigError(`${where}.${key}[${index}]: expected a non-empty string`);
    }
    return item.trim();
  });
}

export function readEnum<T extends string>(
  obj: JsonObject,
  key: string,
  allowed: readonly T[],
  where: string,
): T {
  const value = readString(obj, key, where);
  return parseEnum(value, allowed, `${where}.${key}`);
}

export function parseEnum<T extends string>(value: string, allowed: readonly T[], where: string): T {
  const match = allowed.find((option) => option === value);
  if (match === undefined) {
    throw new ConfigError(`${where}: "${value}" is not one of ${allowed.join(", ")}`);
  }
  return match;
}

export function readJsonFile(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read ${filePath}: ${String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${filePath}: ${String(error)}`);
  }
}
