import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import {
  AGGREGATE_CHAINS,
  AGGREGATE_LOCKS,
  withAggregateLock,
} from "./aggregate-lock";
import {
  aggregateExecutionRows,
  aggregateFences as fences,
} from "./aggregate-lock-order.fixture";

describe("aggregate acquisition ordering", () => {
  test("locks chat receipts in thread, interaction and receipt order", async () => {
    const fixture = fences();
    const statements: SQL[] = [];
    const tx = {
      execute: async (statement: SQL) => {
        statements.push(statement);
        return aggregateExecutionRows(statement);
      },
    };
    await withAggregateLock({ ...fixture.chatThread, tx });
    await withAggregateLock({ ...fixture.chatTurn, tx });
    await withAggregateLock({ ...fixture.chatSecret, tx });
    const dialect = new PgDialect();
    const queries = statements.map((statement) =>
      dialect.sqlToQuery(statement),
    );
    expect(queries.map(({ sql }) => sql)).toEqual([
      expect.stringContaining('"chat_threads"'),
      expect.stringContaining('"chat_turns"'),
      expect.stringContaining('"chat_secrets"'),
    ]);
    expect(queries.map(({ params }) => params)).toEqual([
      [
        fixture.chatThread.id.id,
        fixture.chatThread.id.organizationId,
        fixture.chatThread.id.userId,
      ],
      [
        fixture.chatTurn.id.threadId,
        fixture.chatTurn.id.toolCallId,
        fixture.chatTurn.id.organizationId,
        fixture.chatTurn.id.userId,
      ],
      [
        fixture.chatSecret.id.id,
        fixture.chatSecret.id.threadId,
        fixture.chatSecret.id.organizationId,
        fixture.chatSecret.id.userId,
      ],
    ]);
  });

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
