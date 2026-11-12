import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRequest, REFUSAL_FALLBACK_BETA, type ChatMessage } from "../src/llm/request.ts";
import { loadSystemPrompt } from "../src/prompt/system-prompt.ts";
import { repoConfig, withAssistant } from "./helpers.ts";

const config = repoConfig();
const system = loadSystemPrompt(config);
const question: ChatMessage[] = [{ role: "user", content: "Какую CRM выбрать?" }];

describe("buildRequest", () => {
  it("кладёт системный промпт и настройки модели", () => {
    const request = buildRequest(config.assistant, system, question);
    assert.equal(request.system, system.text);
    assert.equal(request.model, config.assistant.model);
    assert.equal(request.max_tokens, config.assistant.maxTokens);
    assert.deepEqual(request.output_config, { effort: config.assistant.effort });
    assert.deepEqual(request.messages, question);
  });

  it("без промпта это та же модель, отличается только system", () => {
    const withPrompt = buildRequest(config.assistant, system, question);
    const raw = buildRequest(config.assistant, null, question);
    assert.equal(raw.system, undefined);
    const { system: _ignored, ...rest } = withPrompt;
    assert.deepEqual(raw, rest);
  });

  it("включает серверный повтор при отказе, если он разрешён", () => {
    const on = buildRequest(config.assistant, system, question);
    assert.deepEqual(on.betas, [REFUSAL_FALLBACK_BETA]);
    assert.equal(on.fallbacks, "default");
    const off = buildRequest(withAssistant(config, { refusalFallback: false }).assistant, system, question);
    assert.equal(off.betas, undefined);
    assert.equal(off.fallbacks, undefined);
  });

  it("не отправляет устаревшие параметры сэмплинга", () => {
    const request = buildRequest(config.assistant, system, question);
    for (const key of ["temperature", "top_p", "top_k"]) {
      assert.equal(Object.hasOwn(request, key), false);
    }
  });

  it("диалог должен начинаться с сообщения клиента", () => {
    assert.throws(() => buildRequest(config.assistant, system, []));
    assert.throws(() => buildRequest(config.assistant, system, [{ role: "assistant", content: "Hi" }]));
  });
});
