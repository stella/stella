import { describe, expect, test } from "bun:test";

import { stella } from "@/api/db/rls";
import {
  aggregateFences,
  aggregateRecorder,
} from "@/api/tests/fixtures/aggregate-lock-order";

import { AGGREGATE_LOCKS, withAggregateLock } from "./aggregate-lock";
import roleCensus from "./role-privilege-census.json" with { type: "json" };

const ROW_LOCK_CLAUSE = /\bFOR (?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/u;
const LOCKED_TABLE = /\bFROM "public"\."(?<table>[^"]+)"/u;

const applicationPrivileges = new Set(
  roleCensus.roles.find(({ role }) => role === stella.name)?.privileges,
);

// Row-locking clauses need UPDATE on the table or on at least one column,
// as PostgreSQL resolves it for the role (`EFFECTIVE`).
const applicationCanLock = (table: string) =>
  applicationPrivileges.has(`table:public.${table}:UPDATE:EFFECTIVE`) ||
  [...applicationPrivileges].some(
    (privilege) =>
      privilege.startsWith(`column:public.${table}.`) &&
      privilege.endsWith(":UPDATE:EFFECTIVE"),
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

const lockedTables = async (fence: ReturnType<typeof fences>[number]) => {
  const { tx, statements } = aggregateRecorder();
  await withAggregateLock({ ...fence, tx });
  return statements
    .filter(({ sql }) => ROW_LOCK_CLAUSE.test(sql))
    .map(
      ({ sql }) =>
        LOCKED_TABLE.exec(sql)?.groups?.["table"] ??
        `unparsed row lock: ${sql}`,
    );
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
    const problems: string[] = [];
    for (const fence of acquisitions) {
      const definition = AGGREGATE_LOCKS[fence.aggregate];
      const { tables } = fence;
      if (definition.kind === "advisory") {
        if (tables.length > 0) {
          problems.push(
            `${fence.aggregate} is advisory but row-locks ${tables.join(", ")}`,
          );
        }
        continue;
      }
      if (tables.length === 0) {
        problems.push(`${fence.aggregate} is a row aggregate but locks no row`);
      }
      for (const table of tables) {
        const lockable = applicationCanLock(table);
        if (definition.holder === "application" && !lockable) {
          problems.push(
            `${fence.aggregate} locks public.${table}, where role ${stella.name} has no UPDATE; grant it or declare holder "owner"`,
          );
        }
        if (definition.holder === "owner" && lockable) {
          problems.push(
            `${fence.aggregate} declares holder "owner" but role ${stella.name} can lock public.${table}; declare holder "application"`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
