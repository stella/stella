import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  legalListFactDetails,
  legalListItems,
  legalListItemSources,
  legalLists,
  workspaces,
  workspaceViews,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { executeRowsScopedDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { seedLegalLists } from "./seed-legal-lists";
import { seedId } from "./seed-utils";

test("legal list fixtures keep live in-matter provenance and converge on replay", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const organizationId = toSafeId<"organization">("seed-list-org");
  const workspaceId = seedId<"workspace">("seed-list-matter");
  const emptyWorkspaceId = seedId<"workspace">("seed-list-empty-matter");
  const documentId = seedId<"entity">("seed-list-document");
  const versionId = seedId<"entityVersion">("seed-list-version");
  // Sort the tombstoned candidate first so omitting the live-version filter fails.
  const deletedDocumentId = toSafeId<"entity">(
    "00000000-0000-5000-8000-000000000000",
  );
  const deletedVersionId = seedId<"entityVersion">("seed-list-deleted-version");
  const userId = "seed-list-owner";
  const scopedDb = executeRowsScopedDb(
    async (run) => await db.transaction(run),
  );
  try {
    await db.insert(organization).values({
      id: organizationId,
      name: "Synthetic fixture organization",
      slug: "seed-list-org",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(user).values({
      id: userId,
      name: "Synthetic fixture owner",
      email: "seed-list@example.test",
      emailVerified: true,
    });
    await db.insert(workspaces).values([
      {
        id: workspaceId,
        organizationId,
        name: "Synthetic source matter",
        reference: "SAMPLE-1",
      },
      {
        id: emptyWorkspaceId,
        organizationId,
        name: "Synthetic empty matter",
        reference: "SAMPLE-2",
      },
    ]);
    await db.insert(entities).values([
      {
        id: documentId,
        workspaceId,
        name: "Synthetic document",
        kind: "document",
      },
      {
        id: deletedDocumentId,
        workspaceId,
        name: "Deleted synthetic document",
        kind: "document",
      },
    ]);
    await db.insert(entityVersions).values([
      { id: versionId, entityId: documentId, workspaceId },
      {
        id: deletedVersionId,
        entityId: deletedDocumentId,
        workspaceId,
        deletedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    await db
      .update(entities)
      .set({ currentVersionId: versionId })
      .where(eq(entities.id, documentId));
    await db
      .update(entities)
      .set({ currentVersionId: deletedVersionId })
      .where(eq(entities.id, deletedDocumentId));

    expect(deletedDocumentId < documentId).toBe(true);
    const fixture = await seedLegalLists(scopedDb, { workspaceId, userId });
    const readFixture = async () => ({
      lists: await db
        .select()
        .from(legalLists)
        .where(eq(legalLists.workspaceId, workspaceId)),
      items: await db
        .select()
        .from(legalListItems)
        .where(eq(legalListItems.workspaceId, workspaceId))
        .orderBy(legalListItems.position),
      facts: await db
        .select()
        .from(legalListFactDetails)
        .where(eq(legalListFactDetails.workspaceId, workspaceId))
        .orderBy(legalListFactDetails.itemEntityId),
      sources: await db
        .select()
        .from(legalListItemSources)
        .where(eq(legalListItemSources.workspaceId, workspaceId)),
      views: await db
        .select()
        .from(workspaceViews)
        .where(eq(workspaceViews.workspaceId, workspaceId)),
      entities: await db
        .select()
        .from(entities)
        .where(eq(entities.workspaceId, workspaceId))
        .orderBy(entities.id),
      currentVersions: await db
        .select({ entityId: entities.id, versionId: entityVersions.id })
        .from(entities)
        .innerJoin(
          entityVersions,
          and(
            eq(entities.currentVersionId, entityVersions.id),
            eq(entities.id, entityVersions.entityId),
            eq(entities.workspaceId, entityVersions.workspaceId),
          ),
        )
        .where(eq(entities.workspaceId, workspaceId))
        .orderBy(entities.id),
    });
    const first = await readFixture();
    expect(first.lists).toHaveLength(1);
    expect(first.items.map(({ entityId }) => entityId)).toEqual(
      fixture.itemEntityIds,
    );
    expect(first.facts).toHaveLength(3);
    expect(first.entities).toHaveLength(5);
    expect(first.currentVersions).toHaveLength(first.entities.length);
    expect(first.sources).toEqual([
      expect.objectContaining({
        id: fixture.sourceId,
        listId: fixture.listId,
        itemEntityId: fixture.itemEntityIds.at(0),
        sourceEntityId: documentId,
        sourceEntityVersionId: versionId,
        locator: { type: "document" },
      }),
    ]);
    expect(first.views).toEqual([
      expect.objectContaining({
        id: fixture.viewId,
        layout: expect.objectContaining({
          type: "avt",
          listId: fixture.listId,
        }),
      }),
    ]);
    expect(await seedLegalLists(scopedDb, { workspaceId, userId })).toEqual(
      fixture,
    );
    expect(await readFixture()).toEqual(first);

    // A document in another matter cannot satisfy the fixture's precondition.
    expect(
      await rejectionOf(
        seedLegalLists(scopedDb, { workspaceId: emptyWorkspaceId, userId }),
      ),
    ).toMatchObject({
      message: "Legal list fixtures require a seeded document version",
    });
    expect(
      await db
        .select()
        .from(legalLists)
        .where(eq(legalLists.workspaceId, emptyWorkspaceId)),
    ).toHaveLength(0);
  } finally {
    await client.close();
  }
}, 120_000);
