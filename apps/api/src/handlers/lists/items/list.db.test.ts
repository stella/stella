/**
 * The item listing reads each fact's evidential detail through a left join,
 * so an item without a detail row lists `factDetails: null` while an item with
 * one lists the whole object, whichever of its optional columns are empty.
 * How the join's nullable columns map onto that object is decided by the
 * database driver's row mapper, so only a real database shows it. The same
 * holds for the first source each item lists, read through a lateral join.
 */

import { Result } from "better-result";
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { inArray, sql } from "drizzle-orm";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  legalListFactDetails,
  legalListItemSources,
  legalListItems,
  legalLists,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import readListItems from "@/api/handlers/lists/items/list";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  createFeatureAccessSnapshot,
  decideFeatureAccess,
} from "@/api/lib/feature-access/policy";
import {
  FEATURE_REGISTRY,
  LEGAL_LISTS_FEATURE_ID,
  LIST_VERIFICATION_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

type ReadListItemsCtx = Parameters<typeof readListItems.handler>[0];

setDefaultTimeout(30_000);

let testDb: TestDatabase;
const testState = createTestState({ file: import.meta.path, config: env });
const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
const userId = toSafeId<"user">(`user_${Bun.randomUUIDv7()}`);
const workspaceId = createSafeId<"workspace">();
const listId = createSafeId<"legalList">();
const undatedFactId = createSafeId<"entity">();
const datedFactId = createSafeId<"entity">();
const bareFactId = createSafeId<"entity">();
const emailDocumentId = createSafeId<"entity">();
const emailVersionId = createSafeId<"entityVersion">();
const minutesDocumentId = createSafeId<"entity">();
const minutesVersionId = createSafeId<"entityVersion">();

testState.beforeAll(async () => {
  testState.setConfig("FEATURE_LEGAL_LISTS", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "legal-lists": [{ type: "organization", organizationId }],
  });
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
      emailVerified: true,
    });
    await tx.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
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

    await tx.insert(entities).values([
      {
        id: emailDocumentId,
        workspaceId,
        kind: "document" as const,
        name: "Email bundle.pdf",
        createdBy: userId,
      },
      {
        id: minutesDocumentId,
        workspaceId,
        kind: "document" as const,
        name: "Board minutes.docx",
        createdBy: userId,
      },
    ]);
    await tx.insert(entityVersions).values([
      { id: emailVersionId, workspaceId, entityId: emailDocumentId },
      { id: minutesVersionId, workspaceId, entityId: minutesDocumentId },
    ]);
    const email = {
      sourceEntityId: emailDocumentId,
      sourceEntityVersionId: emailVersionId,
    };
    const minutes = {
      sourceEntityId: minutesDocumentId,
      sourceEntityVersionId: minutesVersionId,
    };
    const itemSource = (
      itemEntityId: SafeId<"entity">,
      createdAt: string,
      values: Pick<
        typeof legalListItemSources.$inferInsert,
        | "sourceEntityId"
        | "sourceEntityVersionId"
        | "locator"
        | "verificationStatus"
      >,
    ): typeof legalListItemSources.$inferInsert => ({
      id: createSafeId<"legalListItemSource">(),
      workspaceId,
      listId,
      itemEntityId,
      createdAt: new Date(createdAt),
      createdBy: userId,
      ...values,
    });
    await tx.insert(legalListItemSources).values([
      // The dated fact's oldest source was rejected, so the next one leads.
      itemSource(datedFactId, "2026-01-01T00:00:00Z", {
        ...minutes,
        locator: { type: "docx-block", blockId: "p4" },
        verificationStatus: "rejected",
      }),
      itemSource(datedFactId, "2026-01-03T00:00:00Z", {
        ...minutes,
        locator: { type: "document" },
        verificationStatus: "verified",
      }),
      itemSource(datedFactId, "2026-01-02T00:00:00Z", {
        ...email,
        locator: { type: "pdf-page", pageNumber: 488 },
        verificationStatus: "unverified",
      }),
      // A fact whose only source was rejected lists none.
      itemSource(undatedFactId, "2026-01-01T00:00:00Z", {
        ...email,
        locator: { type: "pdf-page", pageNumber: 2 },
        verificationStatus: "rejected",
      }),
    ]);
  });
});

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

const listedItems = async (granted = true) => {
  const organizationGrant = { type: "organization", organizationId } as const;
  const featureAccessSnapshot = createFeatureAccessSnapshot({
    organizationId,
    userId,
    decisions: new Map(
      [LEGAL_LISTS_FEATURE_ID, LIST_VERIFICATION_FEATURE_ID].map(
        (featureId) => [
          featureId,
          decideFeatureAccess({
            registry: FEATURE_REGISTRY,
            featureId,
            organizationId,
            userId,
            membership: true,
            user: { email: "member@example.test", emailVerified: true },
            grants: {
              [LEGAL_LISTS_FEATURE_ID]: [organizationGrant],
              ...(granted
                ? { [LIST_VERIFICATION_FEATURE_ID]: [organizationGrant] }
                : {}),
            },
          }),
        ],
      ),
    ),
  });
  const result = await readListItems.handler(
    createTestHandlerContext<ReadListItemsCtx>({
      workspaceId,
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      safeDb: testSafeDb,
      featureAccessSnapshot,
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

const firstSourceOf = async (entityId: SafeId<"entity">) => {
  const item = (await listedItems()).find((row) => row.id === entityId);
  if (!item) {
    throw new Error(`item ${entityId} missing from the listing`);
  }
  return item.firstSource;
};

test("lists an item's oldest source that is not rejected", async () => {
  expect(await firstSourceOf(datedFactId)).toEqual({
    documentId: emailDocumentId,
    documentName: "Email bundle.pdf",
    locator: { type: "pdf-page", pageNumber: 488 },
  });
});

test("an item whose sources were all rejected lists none", async () => {
  expect(await firstSourceOf(undatedFactId)).toBeNull();
});

test("an item without sources lists none, once per item", async () => {
  const items = await listedItems();
  expect(items.map((item) => item.id)).toEqual([
    undatedFactId,
    datedFactId,
    bareFactId,
  ]);
  expect(await firstSourceOf(bareFactId)).toBeNull();
});

test("shared item reads retain ordinary details for ungranted callers", async () => {
  const granted = await listedItems(true);
  const hidden = await listedItems(false);
  expect(hidden.map((item) => item.id)).toEqual(granted.map((item) => item.id));
  for (const item of hidden) {
    if (item.factDetails !== null) {
      expect(item.factDetails).not.toHaveProperty("scoring");
    }
    const visible = granted.find((candidate) => candidate.id === item.id);
    expect(visible).toBeDefined();
    if (visible?.factDetails === null || visible?.factDetails === undefined) {
      expect(item.factDetails).toBeNull();
      continue;
    }
    const { scoring, ...ordinary } = visible.factDetails;
    expect(scoring).toBeDefined();
    expect(item.factDetails).toEqual(ordinary);
    expect(item.firstSource).toEqual(visible.firstSource);
  }
});
