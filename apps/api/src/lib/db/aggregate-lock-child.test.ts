import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { createSafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withAggregateRowQuery,
} from "@/api/lib/db/aggregate-lock";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  documentSourceFixture,
  plantedDescendingDocumentChildren,
} from "./aggregate-lock-child.fixture";

test("a planted descending child declaration is rejected before its SELECT", async () => {
  const tx = asTestRaw<Transaction>({ execute: async () => [] });
  expect(
    await rejectionOf(plantedDescendingDocumentChildren(tx)),
  ).toMatchObject({
    message: "Aggregate child locks must ascend by registered rank",
  });
});

test("joined source locks preserve every target and retain child rank history", async () => {
  const fixture = documentSourceFixture();
  const tx = asTestRaw<Transaction>({ execute: async () => [{ id: "held" }] });
  const queries: string[] = [];
  const targets: string[][] = [];
  const result = await withAggregateRowQuery({
    tx,
    aggregate: "entity",
    id: { id: fixture.entityId, workspaceId: fixture.workspaceId },
    children: fixture.children,
    mode: "update",
    select: () => {
      const query = fixture.select();
      return {
        toSQL: () => query.toSQL(),
        as: (alias: string) => query.as(alias),
        where: (predicate: SQL) => {
          const scoped = query.where(predicate);
          return {
            toSQL: () => scoped.toSQL(),
            as: (alias: string) => scoped.as(alias),
            for: async (...args: Parameters<typeof scoped.for>) => {
              const of = args[1]?.of;
              if (Array.isArray(of)) {
                targets.push(of.map(getTableName));
              } else {
                targets.push(of ? [getTableName(of)] : []);
              }
              queries.push(scoped.for(...args).toSQL().sql);
              return [
                {
                  entityId: fixture.entityId,
                  workspaceId: fixture.workspaceId,
                  versionId: fixture.versionId,
                  versionWorkspaceId: fixture.workspaceId,
                  fieldId: fixture.fieldId,
                  fieldWorkspaceId: fixture.workspaceId,
                },
              ];
            },
          };
        },
      };
    },
  });
  expect(result.status).toBe("locked");
  expect(targets).toEqual([["entities", "entity_versions", "fields"]]);
  expect(queries.at(0)).toContain(
    'for update of "entities", "entity_versions", "fields"',
  );
  expect(
    await rejectionOf(
      withAggregateLock({
        tx,
        aggregate: "entityVersion",
        id: {
          id: createSafeId<"entityVersion">(),
          workspaceId: fixture.workspaceId,
        },
        mode: "update",
      }),
    ),
  ).toMatchObject({ message: "Aggregate lock rank inversion" });
});
