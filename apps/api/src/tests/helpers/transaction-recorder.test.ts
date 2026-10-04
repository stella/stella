import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import {
  apiSourceRoot,
  collectApiModuleGraph,
} from "@/api/tests/api-module-graph";

import {
  assertLockRanks,
  FLOW_LOCK_RANKS,
  type TransactionTrace,
  type TransactionEvent,
} from "./transaction-recorder";

const traceFor = (
  aggregates: readonly string[],
  type: TransactionEvent["type"] = "rowLock",
): TransactionTrace => ({
  events: aggregates.map((aggregate) => ({
    type,
    aggregate,
    table: aggregate,
    mode: "update",
    sql: "",
    params: [],
  })),
});

describe("transaction lock ranks", () => {
  test("accepts every ordered subset and rejects every inverted pair", () => {
    const aggregates = Object.keys(FLOW_LOCK_RANKS);
    for (const type of [
      "rowLock",
      "advisoryLock",
      "firstWrite",
      "writeLock",
    ] as const) {
      for (const [index, aggregate] of aggregates.entries()) {
        assertLockRanks(traceFor(aggregates.slice(index), type));
        for (const preceding of aggregates.slice(0, index)) {
          expect(() =>
            assertLockRanks(traceFor([aggregate, preceding], type)),
          ).toThrow("Lock rank inversion");
        }
      }
    }
    assertLockRanks(traceFor(["workspace", "workspace", "entity", "entity"]));
  });

  test("rejects an aggregate without a declared rank", () => {
    expect(() => assertLockRanks(traceFor(["unknown"]))).toThrow(
      "No lock rank declared",
    );
  });

  test("the production server graph excludes the recorder", async () => {
    const recorder = nodePath.join(
      apiSourceRoot,
      "tests/helpers/transaction-recorder.ts",
    );
    const production = await collectApiModuleGraph(
      nodePath.join(apiSourceRoot, "server.ts"),
    );
    expect(production.has(nodePath.join(apiSourceRoot, "db/root.ts"))).toBe(
      true,
    );
    expect(production.has(recorder)).toBe(false);
    // Positive control: the same traversal must detect this file's import.
    const control = await collectApiModuleGraph(import.meta.path);
    expect(control.has(recorder)).toBe(true);
  });
});
