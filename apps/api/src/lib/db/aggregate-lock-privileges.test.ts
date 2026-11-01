import { describe, expect, test } from "bun:test";
import { TransactionRollbackError } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { stella } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  aggregateFences,
  aggregateRecorder,
} from "@/api/tests/fixtures/aggregate-lock-order";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asOwnerTransaction } from "@/api/tests/helpers/owner-transaction";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import type { AggregateName, OwnerTransaction } from "./aggregate-lock";
import {
  AGGREGATE_LOCKS,
  withAggregateLock,
  withAggregateParentBatch,
  withAggregateSavepoint,
} from "./aggregate-lock";
import roleCensus from "./role-privilege-census.json" with { type: "json" };

const ROW_LOCK_CLAUSE = /\bFOR (?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/u;
const LOCKED_TABLE = /\bFROM (?:"public"\.)?"(?<table>[^"]+)"/u;

const applicationPrivileges = new Set(
  roleCensus.find(({ role }) => role === stella.name)?.privileges,
);

// Row-locking clauses need UPDATE on the table or on at least one column.
const applicationCanLock = (table: string) =>
  applicationPrivileges.has(`table:public.${table}:UPDATE:GRANTABLE:false`) ||
  applicationPrivileges.has(`table:public.${table}:UPDATE:GRANTABLE:true`) ||
  [...applicationPrivileges].some(
    (privilege) =>
      privilege.startsWith(`column:public.${table}.`) &&
      privilege.includes(":UPDATE:GRANTABLE:"),
  );

/** Every physical shape a registered aggregate locks, one acquisition each. */
const fences = () => {
  const registered = aggregateFences();
  const workspaceMemberCleanup = {
    aggregate: "memberCleanup",
    id: {
      type: "workspace-member",
      id: "member-claim",
      workspaceId: registered.workspace.id.id,
    },
    mode: "update",
  } as const;
  return [...Object.values(registered), workspaceMemberCleanup];
};

const rowLockedTables = (statements: readonly { sql: string }[]) =>
  statements
    .filter(({ sql }) => ROW_LOCK_CLAUSE.test(sql))
    .map(
      ({ sql }) =>
        LOCKED_TABLE.exec(sql)?.groups?.["table"] ??
        `unparsed row lock: ${sql}`,
    );

const lockedTables = async (fence: ReturnType<typeof fences>[number]) => {
  const { tx, statements } = aggregateRecorder();
  await withAggregateLock({ ...fence, tx: asOwnerTransaction(tx) });
  return rowLockedTables(statements);
};

/** The tables each registered row aggregate locks, from its real statements. */
const registeredAcquisitions = async () =>
  await Promise.all(
    fences().map(async (fence) => ({
      aggregate: fence.aggregate,
      tables: await lockedTables(fence),
    })),
  );

/** A transaction double whose parents have all disappeared. */
const parentRecorder = () => {
  const statements: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      await Promise.resolve();
      statements.push(new PgDialect().sqlToQuery(statement));
      return [];
    },
  };
  return { tx, statements };
};

/** Every table one full parent batch row-locks, from its real statements. */
const parentBatchTables = async () => {
  const { tx, statements } = parentRecorder();
  await withAggregateParentBatch({
    tx: asOwnerTransaction(tx),
    organizationIds: [mintAuthProviderId<"organization">()],
    workspaceIds: [createSafeId<"workspace">()],
    mode: "key share",
  });
  return rowLockedTables(statements);
};

/** Disagreements between a lock path's declared holder and the grants. */
const holderProblems = (
  path: string,
  aggregate: AggregateName,
  tables: readonly string[],
) => {
  const definition = AGGREGATE_LOCKS[aggregate];
  if (definition.kind === "advisory") {
    return tables.length > 0
      ? [`${path} is advisory but row-locks ${tables.join(", ")}`]
      : [];
  }
  if (tables.length === 0) {
    return [`${path} is a row lock but locks no row`];
  }
  return tables.flatMap((table) => {
    const lockable = applicationCanLock(table);
    if (definition.holder === "application" && !lockable) {
      return [
        `${path} locks public.${table}, where role ${stella.name} has no UPDATE; grant it or declare holder "owner"`,
      ];
    }
    if (definition.holder === "owner" && lockable) {
      return [
        `${path} declares holder "owner" but role ${stella.name} can lock public.${table}; declare holder "application"`,
      ];
    }
    return [];
  });
};

describe("aggregate row locks and the application role's grants", () => {
  test("the census records the application role", () => {
    expect(applicationPrivileges.size).toBeGreaterThan(0);
  });

  test("every row aggregate locks a table its declared holder can lock", async () => {
    const acquisitions = await registeredAcquisitions();
    expect(
      acquisitions.flatMap(({ aggregate, tables }) =>
        holderProblems(aggregate, aggregate, tables),
      ),
    ).toEqual([]);
  });

  test("every table a parent batch locks belongs to a registered aggregate its holder can lock", async () => {
    const owners = new Map<string, AggregateName[]>();
    for (const { aggregate, tables } of await registeredAcquisitions()) {
      for (const table of tables) {
        owners.set(table, [...(owners.get(table) ?? []), aggregate]);
      }
    }
    const tables = await parentBatchTables();
    expect(tables.length).toBeGreaterThan(0);
    expect(
      tables.flatMap((table) => {
        const aggregates = owners.get(table) ?? [];
        return aggregates.length === 0
          ? [
              `a parent batch locks public.${table}, which no registered aggregate locks`,
            ]
          : aggregates.flatMap((aggregate) =>
              holderProblems(`parent batch of ${aggregate}`, aggregate, [
                table,
              ]),
            );
      }),
    ).toEqual([]);
  });

  test("an application transaction cannot take an owner-held parent lock", async () => {
    const { tx, statements } = parentRecorder();
    const batch: {
      tx: typeof tx;
      organizationIds: SafeId<"organization">[];
      mode: "key share";
    } = {
      tx,
      organizationIds: [mintAuthProviderId<"organization">()],
      mode: "key share",
    };
    // The same batch typechecks once its transaction is the owner's.
    await withAggregateParentBatch({
      ...batch,
      tx: asOwnerTransaction(tx),
    });
    expect(rowLockedTables(statements)).toEqual(["organization"]);
    expect(AGGREGATE_LOCKS.organization.holder).toBe("owner");
    // @ts-expect-error organization rows are owner-held; an application transaction is refused
    const refused = async () => await withAggregateParentBatch(batch);
    expect(refused).toBeInstanceOf(Function);
  });

  test("an application transaction cannot take an owner-held aggregate row lock", async () => {
    const { tx, statements } = parentRecorder();
    const lock: {
      aggregate: "organization";
      id: SafeId<"organization">;
      mode: "update";
      tx: typeof tx;
    } = {
      aggregate: "organization",
      id: mintAuthProviderId<"organization">(),
      mode: "update",
      tx,
    };
    // The same lock typechecks once its transaction is the owner's.
    await withAggregateLock({ ...lock, tx: asOwnerTransaction(tx) });
    expect(rowLockedTables(statements)).toEqual(["organization"]);
    // @ts-expect-error organization rows are owner-held; an application transaction is refused
    const refused = async () => await withAggregateLock(lock);
    expect(refused).toBeInstanceOf(Function);
  });

  test("a transaction cast to the owner type is refused before any statement", async () => {
    const { tx, statements } = parentRecorder();
    const cast = asTestRaw<OwnerTransaction<Transaction>>(tx);
    const organizationId = mintAuthProviderId<"organization">();
    expect(
      await rejectionOf(
        withAggregateLock({
          aggregate: "organization",
          id: organizationId,
          mode: "update",
          tx: cast,
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining("owner-held") });
    expect(
      await rejectionOf(
        withAggregateParentBatch({
          tx: cast,
          organizationIds: [organizationId],
          mode: "key share",
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining("owner-held") });
    expect(statements).toEqual([]);
  });

  test("a savepoint of an owner transaction keeps the owner registration", async () => {
    const statements: string[] = [];
    const nested = {
      rollback: () => {
        throw new TransactionRollbackError();
      },
      execute: async (statement: SQL) => {
        statements.push(new PgDialect().sqlToQuery(statement).sql);
        return [];
      },
    };
    const owner = asOwnerTransaction({
      ...nested,
      transaction: async (run: (savepoint: Transaction) => Promise<unknown>) =>
        await run(asTestRaw<Transaction>({ ...nested })),
    });
    await withAggregateSavepoint(owner, async (savepoint) => {
      await withAggregateLock({
        aggregate: "organization",
        id: mintAuthProviderId<"organization">(),
        mode: "update",
        tx: asTestRaw<OwnerTransaction<Transaction>>(savepoint),
      });
    });
    expect(rowLockedTables(statements.map((sql) => ({ sql })))).toEqual([
      "organization",
    ]);
  });
});
