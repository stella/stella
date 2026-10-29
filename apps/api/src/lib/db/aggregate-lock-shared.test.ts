import { panic } from "better-result";
import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import {
  aggregateExecutionRows,
  aggregateFences,
} from "@/api/tests/fixtures/aggregate-lock-order";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  ADVISORY_LOCK_MODES,
  AggregateLockBusy,
  AggregateLockUpgradeRefused,
  withAggregateLock,
  withAggregateSavepoint,
  withAggregateTransaction,
} from "./aggregate-lock";

const recorder = () => {
  const statements: string[] = [];
  const execute = async (statement: SQL) => {
    statements.push(new PgDialect().sqlToQuery(statement).sql);
    return aggregateExecutionRows(statement);
  };
  const rollback = (): never => {
    throw new TransactionRollbackError();
  };
  const tx = asTestRaw<Transaction>({
    execute,
    rollback,
    transaction: async (run: (child: Transaction) => Promise<unknown>) =>
      await run(asTestRaw<Transaction>({ execute, rollback })),
  });
  return { tx, statements };
};

for (const mode of ADVISORY_LOCK_MODES) {
  for (const wait of ["block", "nowait"] as const) {
    test(`${mode} advisory ${wait} uses its PostgreSQL primitive`, async () => {
      const { tx, statements } = recorder();
      expect(
        await withAggregateLock({
          ...aggregateFences().orgFeatureAdmission,
          tx,
          mode,
          wait,
        }),
      ).toEqual({ status: "locked" });
      const primitive = `pg_${wait === "nowait" ? "try_" : ""}advisory_xact_lock${mode === "shared" ? "_shared" : ""}(`;
      expect(statements).toHaveLength(1);
      expect(statements.at(0)).toContain(primitive);
    });
    for (const requested of ADVISORY_LOCK_MODES) {
      test(`${mode} then ${requested} advisory ${wait} preserves held coverage`, async () => {
        const { tx, statements } = recorder();
        const fixture = aggregateFences();
        await withAggregateLock({ ...fixture.orgFeatureAdmission, tx, mode });
        await withAggregateLock({ ...fixture.entity, tx });
        const request = withAggregateLock({
          ...fixture.orgFeatureAdmission,
          tx,
          mode: requested,
          wait,
        });
        if (mode === "shared" && requested === "exclusive") {
          expect(await rejectionOf(request)).toBeInstanceOf(
            AggregateLockUpgradeRefused,
          );
          expect(statements).toHaveLength(2);
          return;
        }
        expect(await request).toEqual({ status: "locked" });
        expect(statements).toHaveLength(requested === "shared" ? 2 : 3);
      });
    }
  }
}

test("omitting advisory mode retains exclusive acquisition", async () => {
  const { tx, statements } = recorder();
  await withAggregateLock({ ...aggregateFences().orgFeatureAdmission, tx });
  expect(statements.at(0)).toContain("pg_advisory_xact_lock(");
});

test("shared blocking requests retain the registered rank order", async () => {
  const { tx, statements } = recorder();
  const fixture = aggregateFences();
  await withAggregateLock({
    ...fixture.orgFeatureAdmission,
    tx,
    mode: "shared",
  });
  await withAggregateLock({ ...fixture.entity, tx });
  expect(
    await rejectionOf(
      withAggregateLock({ ...fixture.definitionCap, tx, mode: "shared" }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
  expect(
    statements.filter((statement) => statement.includes("advisory_xact_lock")),
  ).toHaveLength(1);
});

test("a busy shared NOWAIT request holds no mode or ordering reservation", async () => {
  const fixture = aggregateFences();
  let acquired = false;
  const tx = {
    execute: async (statement: SQL) =>
      aggregateExecutionRows(statement).map((row) => ({ ...row, acquired })),
  };
  const result = await withAggregateLock({
    ...fixture.definitionCap,
    tx,
    mode: "shared",
    wait: "nowait",
  });
  expect(result.status).toBe("busy");
  if (result.status !== "busy") {
    panic("Expected busy acquisition");
  }
  expect(result.error).toBeInstanceOf(AggregateLockBusy);
  acquired = true;
  expect(
    await withAggregateLock({ ...fixture.orgFeatureAdmission, tx }),
  ).toEqual({ status: "locked" });
  expect(await withAggregateLock({ ...fixture.definitionCap, tx })).toEqual({
    status: "locked",
  });
});

test("physical hash aliases cannot upgrade a shared hold", async () => {
  const fixture = aggregateFences();
  const statements: string[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      statements.push(new PgDialect().sqlToQuery(statement).sql);
      return [{ key1: 11, key2: 12, acquired: true }];
    },
  };
  await withAggregateLock({
    ...fixture.orgFeatureAdmission,
    tx,
    mode: "shared",
  });
  expect(
    await rejectionOf(withAggregateLock({ ...fixture.definitionCap, tx })),
  ).toBeInstanceOf(AggregateLockUpgradeRefused);
  expect(statements).toHaveLength(2);
  expect(statements.at(1)).not.toContain("advisory_xact_lock");
});

test("shared history survives savepoint commit and excludes rolled back holds", async () => {
  const fixture = aggregateFences();
  const { tx } = recorder();
  await withAggregateSavepoint(tx, async (child) => {
    await withAggregateLock({
      ...fixture.orgFeatureAdmission,
      tx: child,
      mode: "shared",
    });
  });
  await withAggregateSavepoint(tx, async (child) => {
    expect(
      await rejectionOf(
        withAggregateLock({
          ...fixture.orgFeatureAdmission,
          tx: child,
          mode: "exclusive",
          wait: "nowait",
        }),
      ),
    ).toBeInstanceOf(AggregateLockUpgradeRefused);
  });
  const fresh = recorder();
  expect(
    await rejectionOf(
      withAggregateSavepoint(fresh.tx, async (child) => {
        await withAggregateLock({
          ...fixture.orgFeatureAdmission,
          tx: child,
          mode: "shared",
        });
        return panic("Roll back shared fixture");
      }),
    ),
  ).toMatchObject({ message: "Roll back shared fixture" });
  expect(
    await withAggregateLock({ ...fixture.orgFeatureAdmission, tx: fresh.tx }),
  ).toEqual({ status: "locked" });
});

test("exclusive physical aliases cover shared reentry without reacquiring", async () => {
  const fixture = aggregateFences();
  const statements: string[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      statements.push(new PgDialect().sqlToQuery(statement).sql);
      return [{ key1: 11, key2: 12, acquired: true }];
    },
  };
  await withAggregateLock({ ...fixture.orgFeatureAdmission, tx });
  expect(
    await withAggregateLock({ ...fixture.definitionCap, tx, mode: "shared" }),
  ).toEqual({ status: "locked" });
  expect(
    await withAggregateLock({ ...fixture.definitionCap, tx, mode: "shared" }),
  ).toEqual({ status: "locked" });
  expect(statements).toHaveLength(2);
  expect(statements.at(1)).not.toContain("advisory_xact_lock");
});

test("shared savepoint reentry keeps ancestor exclusive coverage", async () => {
  const fixture = aggregateFences();
  const { tx, statements } = recorder();
  await withAggregateLock({ ...fixture.orgFeatureAdmission, tx });
  await withAggregateSavepoint(tx, async (child) => {
    expect(
      await withAggregateLock({
        ...fixture.orgFeatureAdmission,
        tx: child,
        mode: "shared",
      }),
    ).toEqual({ status: "locked" });
    expect(
      await withAggregateLock({
        ...fixture.orgFeatureAdmission,
        tx: child,
        mode: "exclusive",
      }),
    ).toEqual({ status: "locked" });
  });
  expect(statements).toHaveLength(2);
});

test.each(["commit", "rollback"] as const)(
  "a root savepoint %s leaves the database reusable for later transactions",
  async (outcome) => {
    const root = {
      transaction: async <T>(run: (tx: Transaction) => Promise<T>) =>
        await run(recorder().tx),
    };
    const first = withAggregateSavepoint(root, async (tx) => {
      await withAggregateLock({ ...aggregateFences().orgFeatureAdmission, tx });
      if (outcome === "rollback") {
        tx.rollback();
      }
      return "committed";
    });
    if (outcome === "rollback") {
      expect(await rejectionOf(first)).toBeInstanceOf(TransactionRollbackError);
    } else {
      expect(await first).toBe("committed");
    }
    for (const iteration of [1, 2]) {
      expect(
        await withAggregateTransaction(root, async (tx) => {
          await withAggregateLock({
            ...aggregateFences().orgFeatureAdmission,
            tx,
          });
          return iteration;
        }),
      ).toBe(iteration);
    }
  },
);
