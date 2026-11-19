import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenIssuer } from "../src/auth/token.ts";
import { parseStaffEnv, StaffDirectory } from "../src/auth/staff.ts";
import { ResponseCache } from "../src/cache/response-cache.ts";
import { meaningOf } from "../src/cache/semantic.ts";
import { KnowledgeBase } from "../src/rag/knowledge.ts";
import { KNOWLEDGE_DIR } from "../src/config/paths.ts";
import { DemoCrm, ToolRegistry, crmTools, leadsCsv } from "../src/tools/crm.ts";

describe("шаг 4: токены и учётные записи", () => {
  it("токен хранит роль, истекает сам и не подделывается", () => {
    let now = 1_000_000;
    const issuer = new TokenIssuer({ ttlSec: 60, now: () => now });
    const { token } = issuer.issue("dana", "manager");
    const check = issuer.verify(token);
    assert.equal(check.ok && check.claims.role, "manager");
    const [v, payload, sig] = token.split(".");
    const tampered = Buffer.from(Buffer.from(payload ?? "", "base64url").toString().replace("manager", "owner")).toString("base64url");
    assert.deepEqual(issuer.verify(`${v}.${tampered}.${sig}`), { ok: false, reason: "bad_signature" });
    assert.deepEqual(new TokenIssuer({ ttlSec: 60 }).verify(token), { ok: false, reason: "bad_signature" });
    now += 61_000;
    assert.deepEqual(issuer.verify(token), { ok: false, reason: "expired" });
  });

  it("VORONIX_STAFF даёт личные входы, пароли только хэшем", () => {
    const accounts = parseStaffEnv("owner:owner:owner-pass-1;aliya:operator:pass:with:colons", "legacy-pass-1");
    assert.deepEqual(accounts.map((a) => `${a.login}/${a.role}`), ["owner/owner", "aliya/operator", "manager/manager"]);
    assert.ok(accounts.every((a) => a.hash.length === 32));
    const dir = new StaffDirectory(accounts);
    assert.equal(dir.verify("ALIYA", "pass:with:colons")?.role, "operator");
    assert.equal(dir.verify("aliya", "nope-nope-1"), null);
    assert.equal(dir.verify("ghost", "pass:with:colons"), null);
    assert.throws(() => parseStaffEnv("x:admin:password-1", undefined), /неизвестная роль/);
    assert.throws(() => parseStaffEnv("bob:operator:short", undefined), /короче 8/);
  });

  it("таблица прав: оператор видит заявки, выгрузка только у менеджера и владельца", () => {
    const crm = new DemoCrm();
    const tools = new ToolRegistry(crmTools(crm));
    const denied: string[] = [];
    tools.onDeny = (name, role) => denied.push(`${role}:${name}`);
    const ctx = (role: "client" | "operator" | "manager" | "owner") => ({ role, unmask: (v: string) => v, now: Date.parse("2026-11-12T10:00:00Z") });
    assert.equal(tools.execute("list_leads", {}, ctx("operator")).ok, true);
    assert.equal(tools.execute("export_leads", {}, ctx("operator")).ok, false);
    assert.equal(tools.execute("export_leads", {}, ctx("owner")).ok, true);
    assert.equal(tools.execute("list_leads", {}, ctx("client")).ok, false);
    assert.deepEqual(denied, ["operator:export_leads", "client:list_leads"]);
    assert.match(leadsCsv(crm), /^booking_id,name/);
    assert.doesNotMatch(leadsCsv(crm), /^"=/m);
  });
});

describe("шаг 6: умный кэш по смыслу", () => {
  const knowledge = KnowledgeBase.load(KNOWLEDGE_DIR);
  const make = () => new ResponseCache({ ttlMs: 60_000, maxEntries: 50, weigh: (t) => knowledge.idf(t) });

  it("похожие формулировки берут готовый ответ", () => {
    const cache = make();
    cache.put("Что умеет VoroniX?", "v", { text: "Многое", servedBy: "m", sources: [] });
    assert.equal(cache.find("Что умеет VoroniX?", "v")?.kind, "exact");
    for (const q of ["Какие функции у VoroniX?", "Расскажите, что может VoroniX", "какие возможности у voronix"]) {
      const hit = cache.find(q, "v");
      assert.equal(hit?.kind, "semantic", q);
      assert.equal(hit.answer.text, "Многое");
    }
    assert.equal(cache.find("Какие функции у VoroniX?", "v2"), undefined);
    assert.equal(cache.stats().semanticHits, 3);
  });

  it("разные вопросы не путаются", () => {
    const cache = make();
    cache.put("Сколько стоит тариф Pro?", "v", { text: "Pro", servedBy: "m", sources: [] });
    assert.equal(cache.find("Сколько стоит тариф Start?", "v"), undefined);
    assert.equal(cache.find("What does VoroniX cost for Pro?", "v"), undefined);
    assert.equal(cache.find("Как подключить Telegram?", "v"), undefined);
    assert.equal(meaningOf("Что умеет VoroniX?").lang, "ru");
  });
});
