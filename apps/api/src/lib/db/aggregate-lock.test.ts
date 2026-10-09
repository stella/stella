import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  AGGREGATE_CHAINS,
  AGGREGATE_LOCKS,
  withAggregateLock,
  withAutomatedFlowRunCapLock,
} from "./aggregate-lock";
import {
  aggregateExecutionRows,
  aggregateFences as fences,
} from "./aggregate-lock-order.fixture";

test("the flow cap owner opens one transaction and awaits its fence before running the decision", async () => {
  const events: string[] = [];
  const tx = asTestRaw<Transaction>({
    execute: async (statement: SQL) => {
      events.push("locked");
      return aggregateExecutionRows(statement);
    },
  });
  const database = asTestRaw<
    Parameters<typeof withAutomatedFlowRunCapLock>[0]["database"]
  >({
    transaction: async (
      run: (transaction: Transaction) => Promise<unknown>,
    ) => {
      events.push("opened");
      const result = await run(tx);
      events.push("committed");
      return result;
    },
  });
  const result = await withAutomatedFlowRunCapLock(
    { definitionId: createSafeId<"flowDefinition">(), database },
    async (transaction) => {
      expect(transaction).toBe(tx);
      expect(events).toEqual(["opened", "locked"]);
      events.push("decision");
      return "started";
    },
  );
  expect(result).toBe("started");
  expect(events).toEqual(["opened", "locked", "decision", "committed"]);
});

test("migrated fences retain workspace share mode, signal scope, and flow cap keys", async () => {
  const fixture = fences();
  const dialect = new PgDialect();
  const statements: ReturnType<typeof dialect.sqlToQuery>[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      statements.push(dialect.sqlToQuery(statement));
      return aggregateExecutionRows(statement);
    },
  };
  await withAggregateLock({ ...fixture.workspace, mode: "share", tx });
  await withAggregateLock({ ...fixture.signal, tx });
  await withAggregateLock({ ...fixture.automatedFlowRunCap, tx });
  const workspace =
    statements.at(0) ?? panic("Workspace lock was not executed");
  expect(workspace.sql).toContain("FOR SHARE");
  expect(workspace.params).toEqual([
    fixture.workspace.id.id,
    fixture.workspace.id.organizationId,
  ]);
  const signal = statements.at(1) ?? panic("Signal lock was not executed");
  expect(signal.sql).toContain("FOR UPDATE");
  expect(signal.params).toEqual([
    fixture.signal.id.id,
    fixture.signal.id.organizationId,
  ]);
  const cap = statements.at(2) ?? panic("Flow cap lock was not executed");
  expect(cap.sql).toContain("pg_advisory_xact_lock");
  expect(cap.params).toEqual([
    0x0f_10_cc_a9,
    fixture.automatedFlowRunCap.id,
    0x0f_10_cc_a9,
    fixture.automatedFlowRunCap.id,
  ]);
});

describe("aggregate acquisition ordering", () => {
  test("every declared chain ascends and the chains cover every registered aggregate", () => {
    const exercised = new Set(Object.values(AGGREGATE_CHAINS).flat());
    expect(Object.keys(AGGREGATE_LOCKS).toSorted()).toEqual(
      [...exercised].toSorted(),
    );
    for (const chain of Object.values(AGGREGATE_CHAINS)) {
      for (const [index, aggregate] of chain.entries()) {
        const next = chain.at(index + 1);
        if (next !== undefined) {
          expect(AGGREGATE_LOCKS[aggregate].rank).toBeLessThan(
            AGGREGATE_LOCKS[next].rank,
          );
        }
      }
    }
  });
  test("every ordered rank pair acquires and every inverted pair fails before execution", async () => {
    const ordered = Object.values(fences()).toSorted((left, right) => {
      const rankDifference =
        AGGREGATE_LOCKS[left.aggregate].rank -
        AGGREGATE_LOCKS[right.aggregate].rank;
      if (rankDifference !== 0) {
        return rankDifference;
      }
      if (left.aggregate === right.aggregate) {
        return 0;
      }
      return left.aggregate < right.aggregate ? -1 : 1;
    });
    for (const [index, first] of ordered.entries()) {
      for (const [secondIndex, second] of ordered.entries()) {
        let executions = 0;
        const tx = {
          execute: async (statement: SQL) => {
            executions += 1;
            return aggregateExecutionRows(statement);
          },
        };
        expect(await withAggregateLock({ ...first, tx })).toEqual({
          status: "locked",
        });
        if (secondIndex < index) {
          expect(
            await rejectionOf(withAggregateLock({ ...second, tx })),
          ).toMatchObject({ message: "Aggregate lock rank inversion" });
          expect(executions).toBe(1);
          continue;
        }
        expect(await withAggregateLock({ ...second, tx })).toEqual({
          status: "locked",
        });
        expect(executions).toBe(2);
      }
    }
  });

  test("retains history across helper calls but isolates new transactions and reacquisition", async () => {
    const fixture = fences();
    const tx = {
      execute: async (statement: SQL) => aggregateExecutionRows(statement),
    };
    await withAggregateLock({ ...fixture.workspace, tx });
    await withAggregateLock({ ...fixture.entity, tx });
    expect(await withAggregateLock({ ...fixture.workspace, tx })).toEqual({
      status: "locked",
    });
    expect(
      await rejectionOf(withAggregateLock({ ...fixture.organization, tx })),
    ).toMatchObject({ message: "Aggregate lock rank inversion" });
    const retryTx = {
      execute: async (statement: SQL) => aggregateExecutionRows(statement),
    };
    expect(
      await withAggregateLock({ ...fixture.organization, tx: retryTx }),
    ).toEqual({ status: "locked" });
  });

  test("missing rows consume no rank and scoped reacquisition still executes its predicate", async () => {
    const fixture = fences();
    let found = false;
    const tx = {
      execute: async (statement: SQL) =>
        aggregateExecutionRows(statement, found),
    };
    expect(await withAggregateLock({ ...fixture.entity, tx })).toEqual({
      status: "missing",
    });
    found = true;
    await withAggregateLock({ ...fixture.organization, tx });
    await withAggregateLock({ ...fixture.workspace, tx });
    found = false;
    expect(
      await withAggregateLock({
        aggregate: "workspace",
        mode: "update",
        id: {
          id: fixture.workspace.id.id,
          organizationId: mintAuthProviderId<"organization">(),
        },
        tx,
      }),
    ).toEqual({ status: "missing" });
  });

  test("rejects descending identities and overlapping acquisitions on one transaction", async () => {
    const organizationIds = [
      mintAuthProviderId<"organization">(),
      mintAuthProviderId<"organization">(),
    ].toSorted();
    const first = organizationIds.at(0);
    const last = organizationIds.at(-1);
    if (first === undefined || last === undefined) {
      panic("Missing identity fixture");
    }
    const tx = {
      execute: async (statement: SQL) => aggregateExecutionRows(statement),
    };
    await withAggregateLock({
      aggregate: "contactCapacity",
      id: { organizationId: last },
      tx,
    });
    expect(
      await rejectionOf(
        withAggregateLock({
          aggregate: "contactCapacity",
          id: { organizationId: first },
          tx,
        }),
      ),
    ).toMatchObject({ message: "Aggregate lock rank inversion" });

    const gate = Promise.withResolvers<unknown[]>();
    const pendingTx = {
      execute: async (statement: SQL) => {
        await gate.promise;
        return aggregateExecutionRows(statement);
      },
    };
    const pending = withAggregateLock({
      aggregate: "contactCapacity",
      id: { organizationId: first },
      tx: pendingTx,
    });
    expect(
      await rejectionOf(
        withAggregateLock({
          aggregate: "contactCapacity",
          id: { organizationId: last },
          tx: pendingTx,
        }),
      ),
    ).toMatchObject({
      message: "Await each aggregate lock acquisition before starting another",
    });
    gate.resolve([]);
    expect(await pending).toEqual({ status: "locked" });
  });
});
