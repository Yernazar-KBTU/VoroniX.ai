import { fileURLToPath } from "node:url";
import path from "node:path";

/** Корень репозитория: src/config -> ../../ */
export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const CONFIG_DIR = path.join(PROJECT_ROOT, "config");
export const PROMPTS_DIR = path.join(PROJECT_ROOT, "prompts");
export const DOCS_DIR = path.join(PROJECT_ROOT, "docs");
export const WEB_DIR = path.join(PROJECT_ROOT, "web");
