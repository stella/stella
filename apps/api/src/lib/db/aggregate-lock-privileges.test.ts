import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { stella } from "@/api/db/rls";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  aggregateFences,
  aggregateRecorder,
} from "@/api/tests/fixtures/aggregate-lock-order";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asOwnerTransaction } from "@/api/tests/helpers/owner-transaction";

import type { AggregateName } from "./aggregate-lock";
import {
  AGGREGATE_LOCKS,
  withAggregateLock,
  withAggregateParentBatch,
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
  await withAggregateLock({ ...fence, tx });
  return rowLockedTables(statements);
};

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

/**
 * Lock paths that row-lock outside `withAggregateLock`, each under the
 * registered aggregate whose holder its transaction type takes.
 */
const parentBatchPaths = (): {
  aggregate: AggregateName;
  acquire: () => Promise<string[]>;
}[] => [
  {
    aggregate: "organization",
    acquire: async () => {
      const { tx, statements } = parentRecorder();
      await withAggregateParentBatch({
        tx: asOwnerTransaction(tx),
        organizationIds: [mintAuthProviderId<"organization">()],
        mode: "key share",
      });
      return rowLockedTables(statements);
    },
  },
  {
    aggregate: "workspace",
    acquire: async () => {
      const { tx, statements } = parentRecorder();
      await withAggregateParentBatch({
        tx,
        organizationIds: [],
        workspaceIds: [createSafeId<"workspace">()],
        mode: "key share",
      });
      return rowLockedTables(statements);
    },
  },
];

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
    const acquisitions = await Promise.all(
      fences().map(async (fence) => ({
        aggregate: fence.aggregate,
        tables: await lockedTables(fence),
      })),
    );
    expect(
      acquisitions.flatMap(({ aggregate, tables }) =>
        holderProblems(aggregate, aggregate, tables),
      ),
    ).toEqual([]);
  });

  test("every parent batch path locks a table its aggregate's holder can lock", async () => {
    const acquisitions = await Promise.all(
      parentBatchPaths().map(async ({ aggregate, acquire }) => ({
        aggregate,
        tables: await acquire(),
      })),
    );
    expect(acquisitions.map(({ aggregate }) => aggregate)).toEqual([
      "organization",
      "workspace",
    ]);
    expect(
      acquisitions.flatMap(({ aggregate, tables }) =>
        holderProblems(`parent batch of ${aggregate}`, aggregate, tables),
      ),
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
});
