/**
 * The item listing reads each fact's evidential detail through a left join,
 * so an item without a detail row lists `factDetails: null` while an item with
 * one lists the whole object, whichever of its optional columns are empty.
 * How the join's nullable columns map onto that object is decided by the
 * database driver's row mapper, so only a real database shows it.
 */

import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  legalListFactDetails,
  legalListItems,
  legalLists,
  workspaces,
} from "@/api/db/schema";
import readListItems from "@/api/handlers/lists/items/list";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

type ReadListItemsCtx = Parameters<typeof readListItems.handler>[0];

let testDb: TestDatabase;
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const listId = createSafeId<"legalList">();
const undatedFactId = createSafeId<"entity">();
const datedFactId = createSafeId<"entity">();
const bareFactId = createSafeId<"entity">();

beforeAll(
  async () => {
    testDb = await getTestDb();
    await testDb.transaction(async (tx: TestDatabaseTransaction) => {
      await tx.execute(sql.raw("RESET ROLE"));
      await tx.insert(organization).values({
        id: organizationId,
        name: "List items firm",
        slug: `list-items-${Bun.randomUUIDv7()}`,
        createdAt: new Date(),
      });
      await tx.insert(user).values({
        id: userId,
        name: "List Items User",
        email: `${userId}@example.test`,
      });
      await tx.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "List items matter",
        reference: Bun.randomUUIDv7().slice(0, 8),
      });
      await tx.insert(legalLists).values({
        id: listId,
        workspaceId,
        name: "Chronology",
        status: "active",
        createdBy: userId,
      });

      const facts = [
        { id: undatedFactId, name: "Meeting at the warehouse", position: "a" },
        { id: datedFactId, name: "Contract signed", position: "b" },
        { id: bareFactId, name: "Invoice disputed", position: "c" },
      ];
      await tx.insert(entities).values(
        facts.map((fact) => ({
          id: fact.id,
          workspaceId,
          kind: "task" as const,
          listItemType: LIST_ITEM_TYPE.FACT,
          name: fact.name,
          createdBy: userId,
          agendaKind: "task" as const,
          status: "open" as const,
          priority: "none" as const,
          agendaSource: "manual" as const,
        })),
      );
      await tx.insert(legalListItems).values(
        facts.map((fact) => ({
          entityId: fact.id,
          workspaceId,
          listId,
          position: fact.position,
          addedBy: userId,
        })),
      );
      await tx.insert(legalListFactDetails).values([
        {
          itemEntityId: undatedFactId,
          workspaceId,
          listId,
          confidence: "medium",
          scoring: "held",
          interpretationNote: "Witnesses disagree on who attended.",
        },
        {
          itemEntityId: datedFactId,
          workspaceId,
          listId,
          occurredOn: "2021-07-01",
          occurredOnPrecision: "month",
          evidenceKind: "document",
          medium: "email",
          confidence: "high",
        },
      ]);
    });
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await testDb
    .delete(organization)
    .where(inArray(organization.id, [organizationId]));
  // The user outlives its organization; later suites in a shared batch
  // must not see it.
  await testDb.delete(user).where(inArray(user.id, [userId]));
  await releaseTestDb();
});

/** A `SafeDb` over the test database, wrapping anything thrown. */
const testSafeDb: SafeDb = async (fn) =>
  await Result.tryPromise({
    try: async () =>
      await testDb.transaction(async (tx: TestDatabaseTransaction) => {
        await tx.execute(sql.raw("RESET ROLE"));
        return await fn(asTestRaw<Transaction>(tx));
      }),
    catch: (cause) =>
      new DatabaseError({ message: "test transaction failed", cause }),
  });

const listedItems = async () => {
  const result = await readListItems.handler(
    createTestHandlerContext<ReadListItemsCtx>({
      workspaceId,
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      safeDb: testSafeDb,
      params: { workspaceId, listId },
      query: {},
    }),
  );
  if (!("items" in result)) {
    throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  }
  return result.items;
};

const factDetailsOf = async (entityId: SafeId<"entity">) => {
  const item = (await listedItems()).find((row) => row.id === entityId);
  if (!item) {
    throw new Error(`item ${entityId} missing from the listing`);
  }
  return item.factDetails;
};

test("returns fact details for an undated fact", async () => {
  expect(await factDetailsOf(undatedFactId)).toEqual({
    confidence: "medium",
    occurredOn: null,
    occurredOnPrecision: null,
    evidenceKind: null,
    medium: null,
    interpretationNote: "Witnesses disagree on who attended.",
    scoring: "held",
  });
});

test("returns the date of a dated fact", async () => {
  expect(await factDetailsOf(datedFactId)).toEqual({
    confidence: "high",
    occurredOn: "2021-07-01",
    occurredOnPrecision: "month",
    evidenceKind: "document",
    medium: "email",
    interpretationNote: null,
    scoring: "included",
  });
});

test("an item without details has none", async () => {
  expect(await factDetailsOf(bareFactId)).toBeNull();
});
