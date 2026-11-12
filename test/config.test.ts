import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProductConfig } from "../src/config/product.ts";
import { parseAssistantConfig } from "../src/config/assistant.ts";
import { ConfigError } from "../src/config/errors.ts";

const productJson = JSON.parse(readFileSync(new URL("../config/product.json", import.meta.url), "utf8")) as Record<
  string,
  unknown
>;
const assistantJson = JSON.parse(readFileSync(new URL("../config/assistant.json", import.meta.url), "utf8")) as Record<
  string,
  unknown
>;

describe("product config", () => {
  it("файл из репозитория валиден", () => {
    const product = parseProductConfig(productJson);
    assert.equal(product.name, "VoroniX");
    assert.ok(product.features.length > 0);
    assert.deepEqual(product.assistantLanguages, ["ru", "kk", "en"]);
    assert.equal(product.pricing.published, false);
  });

  it("отклоняет пустые поля", () => {
    assert.throws(() => parseProductConfig({ ...productJson, name: " " }), ConfigError);
    assert.throws(() => parseProductConfig({ ...productJson, features: [] }), ConfigError);
  });

  it("отклоняет неизвестный язык", () => {
    assert.throws(() => parseProductConfig({ ...productJson, assistantLanguages: ["ru", "de"] }), ConfigError);
  });

  it("сайт только по https", () => {
    assert.throws(
      () => parseProductConfig({ ...productJson, contacts: { website: "http://example.com" } }),
      ConfigError,
    );
  });

  it("не даёт держать тарифы, пока цены не опубликованы", () => {
    const pricing = { published: false, plans: [{ name: "A", price: "1", includes: "x" }] };
    assert.throws(() => parseProductConfig({ ...productJson, pricing }), ConfigError);
  });
});

describe("assistant config", () => {
  it("файл из репозитория валиден", () => {
    const config = parseAssistantConfig(assistantJson, {});
    assert.equal(config.model, "claude-opus-5-5");
    assert.equal(config.effort, "medium");
    assert.equal(config.promptVersion, "v1");
  });

  it("модель и усилие можно переопределить через окружение", () => {
    const config = parseAssistantConfig(assistantJson, { VORONIX_MODEL: "claude-sonnet-5-5", VORONIX_EFFORT: "low" });
    assert.equal(config.model, "claude-sonnet-5-5");
    assert.equal(config.effort, "low");
  });

  it("неверное усилие это ошибка", () => {
    assert.throws(() => parseAssistantConfig(assistantJson, { VORONIX_EFFORT: "turbo" }), ConfigError);
    assert.throws(() => parseAssistantConfig({ ...assistantJson, maxTokens: 0 }, {}), ConfigError);
  });
});
