import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import { withAggregateParentBatch } from "@/api/lib/db/aggregate-lock";

import { unlockedWorkspaceParentRead } from "./move-statement-barrier.fixture";

describe("folder move race control", () => {
  test("retains the parent ID projection and bound identity without a row lock", async () => {
    const workspaceId = toSafeId<"workspace">(
      "0198fa3d-fc8d-7000-8000-000000000001",
    );
    const dialect = new PgDialect();
    const read = unlockedWorkspaceParentRead(workspaceId);
    const unlocked = dialect.sqlToQuery(read);
    const lockedQueries: ReturnType<typeof dialect.sqlToQuery>[] = [];
    const result = await withAggregateParentBatch({
      tx: {
        execute: async (statement) => {
          lockedQueries.push(dialect.sqlToQuery(statement));
          return [{ id: workspaceId }];
        },
      },
      organizationIds: [],
      workspaceIds: [workspaceId],
      mode: "update",
    });
    expect(result.workspaceIds).toEqual(new Set([workspaceId]));
    expect(lockedQueries).toHaveLength(1);
    const locked = lockedQueries.at(0);
    expect(locked).toBeDefined();

    expect(unlocked.sql).toContain('SELECT id FROM "workspaces"');
    expect(unlocked.sql).toContain('WHERE "workspaces"."id" IN ($1)');
    expect(unlocked.params).toEqual([workspaceId]);
    expect(locked?.params).toEqual(unlocked.params);
    expect(locked?.sql.replace(/\s+/gu, " ").trim()).toBe(
      `${unlocked.sql.replace(/\s+/gu, " ").trim()} FOR UPDATE`,
    );
    expect(unlocked.sql).not.toContain("FOR UPDATE");
  });
});
