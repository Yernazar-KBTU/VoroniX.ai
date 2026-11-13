import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listPlaceholders, renderTemplate } from "../src/prompt/template.ts";
import { ConfigError } from "../src/config/errors.ts";

describe("renderTemplate", () => {
  it("подставляет все переменные", () => {
    assert.equal(renderTemplate("Hi {{name}}, {{ team }}!", { name: "A", team: "B" }), "Hi A, B!");
  });

  it("падает, если значения для переменной нет", () => {
    assert.throws(() => renderTemplate("{{a}} {{b}}", { a: "1" }), ConfigError);
  });

  it("падает на лишнем значении, чтобы не терять данные молча", () => {
    assert.throws(() => renderTemplate("{{a}}", { a: "1", b: "2" }), ConfigError);
  });

  it("не пропускает недособранный промпт", () => {
    assert.throws(() => renderTemplate("{{a}}", { a: "{{oops}}" }), ConfigError);
  });

  it("находит переменные без повторов и по порядку", () => {
    assert.deepEqual(listPlaceholders("{{b}} {{a}} {{b}}"), ["b", "a"]);
  });
});
