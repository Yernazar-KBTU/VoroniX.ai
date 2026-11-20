import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { TURN_OUTCOMES } from "../src/chat/turn-log.ts";
import type { TurnOutcome } from "../src/chat/turn-log.ts";
import { WEB_DIR } from "../src/config/paths.ts";

interface LogRow {
  readonly sev: string;
  readonly name: string;
  readonly layer: string;
}

type RowsFor = (event: { readonly kind: string; readonly at: string; readonly seq: number; readonly data: Record<string, unknown> }) => LogRow[];

/** Консоль это обычный скрипт без экспорта: из него берётся чистый блок «событие сервера → строки журнала». */
function loadRowsFor(): RowsFor {
  const source = readFileSync(path.join(WEB_DIR, "assets", "console.js"), "utf8");
  const from = source.indexOf("const $ =");
  const to = source.indexOf("/* ---------- filters");
  assert.ok(from >= 0 && to > from, "в console.js не найден блок преобразования событий");
  const api = vm.runInNewContext(`(() => { "use strict"; ${source.slice(from, to)}\nreturn { rowsFor }; })()`) as { rowsFor: RowsFor };
  return api.rowsFor;
}

function modelRows(rowsFor: RowsFor, outcome: string | null): LogRow[] {
  const data: Record<string, unknown> = { session: "abcd", servedBy: "smart", inputTokens: 10, outputTokens: 5, totalMs: 900, costUsd: 0.001 };
  if (outcome !== null) {
    data["outcome"] = outcome;
  }
  return rowsFor({ kind: "turn", at: "2026-01-01T10:00:00.000Z", seq: 1, data }).filter((row) => row.layer === "Model");
}

/** Типизировано по TurnOutcome: новый итог на сервере не пройдёт компиляцию, пока консоль и этот тест о нём не знают. */
const EXPECTED: Record<TurnOutcome, readonly [sev: string, name: string]> = {
  answered: ["Info", "Answer sent"],
  truncated: ["Warning", "Answer cut off"],
  refused: ["Warning", "Answer refused"],
  cancelled: ["Warning", "Answer stopped"],
  failed: ["Warning", "Answer failed"],
  blocked: ["Warning", "Answer blocked"],
};

describe("консоль сотрудника", () => {
  it("каждый итог хода, который пишет сервер, становится строкой журнала с верной подписью и серьёзностью", () => {
    const rowsFor = loadRowsFor();
    for (const outcome of TURN_OUTCOMES) {
      const rows = modelRows(rowsFor, outcome);
      assert.equal(rows.length, 1, outcome);
      const [sev, name] = EXPECTED[outcome];
      assert.equal(rows[0]?.sev, sev, outcome);
      assert.equal(rows[0]?.name, name, outcome);
    }
  });

  it("обычный ответ не помечается предупреждением", () => {
    const rows = modelRows(loadRowsFor(), "answered");
    assert.equal(rows[0]?.sev, "Info");
  });

  it("старые записи журнала с итогами ok и error читаются как раньше", () => {
    const rowsFor = loadRowsFor();
    assert.equal(modelRows(rowsFor, "ok")[0]?.sev, "Info");
    assert.equal(modelRows(rowsFor, "error")[0]?.name, "Answer failed");
  });

  it("незнакомый итог виден как предупреждение, а запись без итога как отправленный ответ", () => {
    const rowsFor = loadRowsFor();
    assert.equal(modelRows(rowsFor, "something_new")[0]?.sev, "Warning");
    assert.equal(modelRows(rowsFor, null)[0]?.name, "Answer sent");
  });
});
