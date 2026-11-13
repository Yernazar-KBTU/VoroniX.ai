import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, loadSystemPrompt, systemPromptPath } from "../src/prompt/system-prompt.ts";
import { ConfigError } from "../src/config/errors.ts";
import { repoConfig, withAssistant } from "./helpers.ts";

const config = repoConfig();
const prompt = loadSystemPrompt(config);

describe("system prompt v1", () => {
  it("собирается без пустых переменных", () => {
    assert.equal(prompt.version, "v2");
    assert.equal(prompt.id, "voronix-assistant");
    assert.doesNotMatch(prompt.text, /\{\{|\}\}/);
  });

  it("содержит факты о продукте из конфига", () => {
    assert.match(prompt.text, /<product_facts>[\s\S]*<\/product_facts>/);
    for (const feature of config.product.features) {
      assert.ok(prompt.text.includes(feature.name), `нет функции ${feature.name}`);
    }
    assert.ok(prompt.text.includes(config.product.contacts.website));
    assert.match(prompt.text, /Pricing: not published yet\./);
  });

  it("называет всех конкурентов, которых нельзя советовать", () => {
    for (const competitor of config.product.competitors) {
      assert.ok(prompt.text.includes(competitor), `нет конкурента ${competitor}`);
    }
  });

  it("содержит все обязательные разделы", () => {
    for (const heading of ["Who you are", "Product facts", "Voice", "Scope", "Competitors", "Honesty", "Language", "Format", "Staying in role"]) {
      assert.match(prompt.text, new RegExp(`^# ${heading}$`, "m"), `нет раздела ${heading}`);
    }
  });

  it("перечисляет языки ответа", () => {
    assert.ok(prompt.text.includes("Russian, Kazakh and English"));
  });

  it("отпечаток стабилен и меняется вместе с текстом", () => {
    assert.equal(loadSystemPrompt(config).fingerprint, prompt.fingerprint);
    assert.match(prompt.fingerprint, /^[0-9a-f]{12}$/);
    const renamed = { ...config, product: { ...config.product, name: "Other" } };
    assert.notEqual(loadSystemPrompt(renamed).fingerprint, prompt.fingerprint);
  });

  it("версия в файле должна совпадать с версией в конфиге", () => {
    const source = "---\nid: voronix-assistant\nversion: v2\n---\nText";
    assert.throws(() => buildSystemPrompt(source, config), ConfigError);
  });

  it("принимает только версии вида vN", () => {
    assert.throws(() => systemPromptPath("../secret"), ConfigError);
    assert.throws(() => loadSystemPrompt(withAssistant(config, { promptVersion: "latest" })), ConfigError);
  });
});
