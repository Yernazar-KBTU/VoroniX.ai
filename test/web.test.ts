import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { DOCS_DIR, WEB_DIR } from "../src/config/paths.ts";

function filesIn(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesIn(full) : [full];
  });
}

const webFiles = filesIn(WEB_DIR);
const htmlFiles = webFiles.filter((file) => file.endsWith(".html"));
const scriptFiles = webFiles.filter((file) => file.endsWith(".js"));

describe("веб-интерфейс", () => {
  it("есть чат, консоль и их скрипты", () => {
    assert.deepEqual(htmlFiles.map((file) => path.basename(file)).sort(), ["console.html", "index.html"]);
    assert.ok(scriptFiles.length >= 3);
  });

  it("скрипты без синтаксических ошибок", () => {
    for (const file of scriptFiles) {
      assert.doesNotThrow(() => new vm.Script(readFileSync(file, "utf8"), { filename: file }), file);
    }
  });

  it("HTML совместим со строгой CSP: нет встроенных скриптов, стилей и обработчиков", () => {
    for (const file of htmlFiles) {
      const html = readFileSync(file, "utf8");
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, file);
      assert.doesNotMatch(html, /\sstyle\s*=/i, file);
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, file);
      assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/i, `${file}: внешние ресурсы запрещены`);
    }
  });

  it("в интерфейсе и отчётах для защиты нет длинных тире", () => {
    const reports = filesIn(path.join(DOCS_DIR, "proof")).filter((file) => path.basename(file) === "README.md");
    for (const file of [...webFiles, ...reports]) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /[–—]/, file);
    }
  });
});
