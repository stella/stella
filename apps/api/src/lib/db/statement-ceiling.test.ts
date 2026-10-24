import { describe, expect, test } from "bun:test";

import {
  queryCountLogger,
  runCountedTransaction,
  runWithQueryCounter,
} from "../db-query-counter";
import {
  createStatementCeilingMonitor,
  DEFAULT_STATEMENT_CEILING,
  runWithStatementCeiling,
  statementCeilingMeasurements,
} from "./statement-ceiling";
import type { StatementCeilingLedger } from "./statement-ceiling";

const emptyLedger = (): StatementCeilingLedger => ({
  request: {},
  mcp: {},
  worker: {},
  scheduler: {},
});
const measure = (statements: number) =>
  runWithQueryCounter(
    (counter) => {
      for (let row = 0; row < statements; row++) {
        queryCountLogger.logQuery('select "id" from "items" where "id" = $1', [
          row,
        ]);
      }
      return counter;
    },
    { detectRepeatedQueries: true },
  );

describe("statement ceilings", () => {
  test.each(["request", "mcp", "worker", "scheduler"] as const)(
    "%s caps invocations and names repeated statements and call sites",
    (kind) => {
      const monitor = createStatementCeilingMonitor(emptyLedger());
      const counter = measure(DEFAULT_STATEMENT_CEILING + 1);
      expect(() =>
        monitor.record({ kind, key: "GET /items", counter }),
      ).toThrow(/GET \/items: 101 statements/u);
      expect(() => monitor.assertSatisfied()).toThrow(
        /101 × .*statement-ceiling.test.ts.* :: select/su,
      );
    },
  );

  test("the default admits exactly 100 statements", () => {
    const monitor = createStatementCeilingMonitor(emptyLedger());
    monitor.record({
      kind: "request",
      key: "GET /items",
      counter: measure(100),
    });
    expect(monitor.observed.get("request GET /items")).toBe(100);
    monitor.assertSatisfied();
  });

  test("allowances must match the observed maximum and disappear at the default", () => {
    const ledger = emptyLedger();
    ledger.request["GET /items"] = {
      threshold: 110,
      reason: "Explicit fixture allowance",
    };
    for (const statements of [100, 101, 109]) {
      const monitor = createStatementCeilingMonitor(ledger);
      monitor.record({
        kind: "request",
        key: "GET /items",
        counter: measure(statements),
      });
      expect(() => monitor.assertSatisfied()).toThrow(
        `Stale statement ceiling: request GET /items: threshold 110, observed maximum ${statements}`,
      );
    }
    const monitor = createStatementCeilingMonitor(ledger);
    monitor.record({
      kind: "request",
      key: "GET /items",
      counter: measure(100),
    });
    monitor.record({
      kind: "request",
      key: "GET /items",
      counter: measure(110),
    });
    monitor.assertSatisfied();
  });

  test.each([Infinity, Number.NaN, 100, 101.5])(
    "rejects invalid allowance %s",
    (threshold) => {
      const ledger = emptyLedger();
      ledger.worker["export"] = {
        threshold,
        reason: "Explicit fixture allowance",
      };
      expect(() => createStatementCeilingMonitor(ledger)).toThrow(
        "Invalid statement ceiling allowance: worker export",
      );
    },
  );

  test("the ceiling combines canonical query and transaction round-trip metrics", async () => {
    const counter = await runWithQueryCounter(async (store) => {
      await runCountedTransaction(async () => {
        queryCountLogger.logQuery("BEGIN", []);
        queryCountLogger.logQuery("select 1", []);
        queryCountLogger.logQuery("COMMIT", []);
      });
      return store;
    });
    expect(counter.count).toBe(1);
    expect(counter.transactions).toBe(2);
    const monitor = createStatementCeilingMonitor(emptyLedger());
    monitor.record({ kind: "request", key: "transaction", counter });
    expect(monitor.observed.get("request transaction")).toBe(3);
    monitor.assertSatisfied();
  });

  test("nested tool counts also belong to their enclosing request", async () => {
    await runWithQueryCounter(async (parent) => {
      await runWithQueryCounter(async (child) => {
        await Promise.resolve();
        queryCountLogger.logQuery("select 1", []);
        expect(child.count).toBe(1);
      });
      expect(parent.count).toBe(1);
    });
  });
});

test("stream continuations remain measured after the response boundary returns", async () => {
  const gate = Promise.withResolvers<undefined>();
  const { completed } = await runWithStatementCeiling({
    kind: "request",
    key: "<stream-continuation>",
    run: () => ({
      completed: (async () => {
        await gate.promise;
        queryCountLogger.logQuery("select 1", []);
      })(),
    }),
  });
  expect(statementCeilingMeasurements()["request <stream-continuation>"]).toBe(
    0,
  );
  gate.resolve(undefined);
  await completed;
  expect(statementCeilingMeasurements()["request <stream-continuation>"]).toBe(
    1,
  );
});
