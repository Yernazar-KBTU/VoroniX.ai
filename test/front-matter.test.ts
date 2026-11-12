import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontMatter } from "../src/prompt/front-matter.ts";
import { ConfigError } from "../src/config/errors.ts";

describe("parseFrontMatter", () => {
  it("читает поля и тело", () => {
    const doc = parseFrontMatter("---\nid: x\nversion: v2\n---\n\nBody text\n", "t");
    assert.deepEqual(doc.meta, { id: "x", version: "v2" });
    assert.equal(doc.body, "Body text");
  });

  it("требует заголовок в начале файла", () => {
    assert.throws(() => parseFrontMatter("Body", "t"), ConfigError);
    assert.throws(() => parseFrontMatter("---\nid: x\n", "t"), ConfigError);
  });
});
