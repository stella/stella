import { expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { Transaction } from "@/api/db/root";
import { toSafeId } from "@/api/lib/branded-types";
import { lockForWrite } from "@/api/lib/db/lock-for-write";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  canonicalParentLockStatement,
  referenceParentLocks,
} from "./parent-lock-reference.fixture";

test.each(["array", "rows"] as const)(
  "returns live parents from the %s driver result shape",
  async (shape) => {
    const organizationId = toSafeId<"organization">("org_live");
    const missingOrganizationId = toSafeId<"organization">("org_missing");
    const workspaceId = toSafeId<"workspace">("workspace_live");
    const missingWorkspaceId = toSafeId<"workspace">("workspace_missing");
    const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const tx = asTestRaw<Pick<Transaction, "execute">>({
      execute: async (query: SQL) => {
        const compiled = new PgDialect().sqlToQuery(query);
        queries.push(compiled);
        const rows = compiled.sql.includes('FROM "organization"')
          ? [{ id: organizationId }]
          : [{ id: workspaceId }];
        return shape === "array" ? rows : { rows };
      },
    });

    const parents = await lockForWrite(tx, {
      organizationIds: [missingOrganizationId, organizationId, organizationId],
      workspaceIds: [missingWorkspaceId, workspaceId, workspaceId],
    });

    expect(parents).toEqual({
      organizationIds: new Set([organizationId]),
      workspaceIds: new Set([workspaceId]),
    });
    expect(queries).toHaveLength(2);
    const organizationQuery = queries.at(0);
    const workspaceQuery = queries.at(1);
    expect(organizationQuery?.sql).toContain('FROM "organization"');
    expect(organizationQuery?.params).toEqual([
      organizationId,
      missingOrganizationId,
    ]);
    expect(workspaceQuery?.sql).toContain('FROM "workspaces"');
    expect(workspaceQuery?.params).toEqual([workspaceId, missingWorkspaceId]);
    for (const query of queries) {
      expect(query.sql).toContain("FOR KEY SHARE");
    }
  },
);

test("adds only byte collation to the reference statements for independent sorted parent batches", async () => {
  const options = {
    organizationIds: [
      toSafeId<"organization">("org_z"),
      toSafeId<"organization">("org_a"),
      toSafeId<"organization">("org_z"),
    ],
    workspaceIds: [
      toSafeId<"workspace">("workspace_z"),
      toSafeId<"workspace">("workspace_a"),
      toSafeId<"workspace">("workspace_z"),
    ],
  };
  const record = () => {
    const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const tx = asTestRaw<Pick<Transaction, "execute">>({
      execute: async (query: SQL) => {
        queries.push(new PgDialect().sqlToQuery(query));
        return [];
      },
    });
    return { tx, queries };
  };
  const reference = record();
  const delegated = record();
  await referenceParentLocks(reference.tx, options);
  await lockForWrite(delegated.tx, options);
  expect(delegated.queries).toEqual(
    reference.queries.map((query) => ({
      ...query,
      sql: canonicalParentLockStatement(query.sql),
    })),
  );
  expect(delegated.queries).toHaveLength(2);
});

test.each(["empty", "organization-only", "workspace-only"] as const)(
  "preserves the %s parent batch statements",
  async (selection) => {
    const options = {
      organizationIds:
        selection === "organization-only"
          ? [toSafeId<"organization">("org_live")]
          : [],
      workspaceIds:
        selection === "workspace-only"
          ? [toSafeId<"workspace">("workspace_live")]
          : [],
    };
    const record = () => {
      const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
      const tx = asTestRaw<Pick<Transaction, "execute">>({
        execute: async (query: SQL) => {
          queries.push(new PgDialect().sqlToQuery(query));
          return [];
        },
      });
      return { tx, queries };
    };
    const reference = record();
    const delegated = record();
    expect(await lockForWrite(delegated.tx, options)).toEqual(
      await referenceParentLocks(reference.tx, options),
    );
    expect(delegated.queries).toEqual(
      reference.queries.map((query) => ({
        ...query,
        sql: canonicalParentLockStatement(query.sql),
      })),
    );
    expect(delegated.queries).toHaveLength(selection === "empty" ? 0 : 1);
  },
);
