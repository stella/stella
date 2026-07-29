import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  chatThreads,
  entities,
  shareItems,
  shareRecipients,
  shareSpaces,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, createShareScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

const activeShareSpaceId = createSafeId<"shareSpace">();
const otherShareSpaceId = createSafeId<"shareSpace">();
const expiredShareSpaceId = createSafeId<"shareSpace">();
const revokedShareSpaceId = createSafeId<"shareSpace">();
const readyShareItemId = createSafeId<"shareItem">();
const publishingShareItemId = createSafeId<"shareItem">();

const readyItemValues = ({
  id,
  shareSpaceId,
  workspaceId,
  organizationId,
  sourceEntityId,
  sourceEntityVersionId,
  sourceFieldId,
}: {
  id: SafeId<"shareItem">;
  shareSpaceId: SafeId<"shareSpace">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  sourceEntityId: SafeId<"entity">;
  sourceEntityVersionId: SafeId<"entityVersion">;
  sourceFieldId: SafeId<"field">;
}) => ({
  id,
  organizationId,
  workspaceId,
  shareSpaceId,
  sourceEntityId,
  sourceEntityVersionId,
  sourceFieldId,
  displayName: `Snapshot ${id}`,
  status: "ready" as const,
  originalFileName: "agreement.docx",
  originalMimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  originalSizeBytes: 1024,
  originalSha256Hex: "a".repeat(64),
  originalStorageKey: `shares/${shareSpaceId}/${id}/original`,
  displayMimeType: "application/pdf",
  displayStorageKey: `shares/${shareSpaceId}/${id}/display.pdf`,
  publishedAt: new Date("2026-07-29T08:00:00.000Z"),
});

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;

    await testDb.insert(shareSpaces).values([
      {
        id: activeShareSpaceId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        name: "Active closing room",
        status: "active",
        accessTokenHash: "1".repeat(64),
        createdBy: ids.userA1,
      },
      {
        id: otherShareSpaceId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA2,
        name: "Other matter room",
        status: "active",
        accessTokenHash: "2".repeat(64),
        createdBy: ids.userA2,
      },
      {
        id: expiredShareSpaceId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        name: "Expired room",
        status: "active",
        accessTokenHash: "3".repeat(64),
        expiresAt: new Date("2000-01-01T00:00:00.000Z"),
        createdBy: ids.userA1,
      },
      {
        id: revokedShareSpaceId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        name: "Revoked room",
        status: "revoked",
        accessTokenHash: "4".repeat(64),
        revokedAt: new Date("2026-07-29T08:30:00.000Z"),
        createdBy: ids.userA1,
      },
    ]);

    await testDb.insert(shareRecipients).values([
      {
        id: createSafeId<"shareRecipient">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        shareSpaceId: activeShareSpaceId,
        emailNormalized: "recipient@example.com",
        userId: ids.userA1,
        status: "verified",
        verifiedAt: new Date("2026-07-29T08:45:00.000Z"),
      },
      {
        id: createSafeId<"shareRecipient">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA2,
        shareSpaceId: otherShareSpaceId,
        emailNormalized: "other@example.com",
        userId: ids.userA2,
        status: "verified",
        verifiedAt: new Date("2026-07-29T08:45:00.000Z"),
      },
      {
        id: createSafeId<"shareRecipient">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        shareSpaceId: expiredShareSpaceId,
        emailNormalized: "expired@example.com",
        userId: ids.userA1,
        status: "verified",
        verifiedAt: new Date("2026-07-29T08:45:00.000Z"),
      },
    ]);

    await testDb.insert(shareItems).values([
      readyItemValues({
        id: readyShareItemId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        shareSpaceId: activeShareSpaceId,
        sourceEntityId: ids.entityA1,
        sourceEntityVersionId: ids.entityVersionA1,
        sourceFieldId: ids.fieldA1,
      }),
      {
        ...readyItemValues({
          id: publishingShareItemId,
          organizationId: ids.orgA,
          workspaceId: ids.wsA1,
          shareSpaceId: activeShareSpaceId,
          sourceEntityId: ids.entityA1,
          sourceEntityVersionId: createSafeId<"entityVersion">(),
          sourceFieldId: ids.fieldA1,
        }),
        status: "publishing",
        originalStorageKey: null,
        displayMimeType: null,
        displayStorageKey: null,
        publishedAt: null,
      },
      readyItemValues({
        id: createSafeId<"shareItem">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA2,
        shareSpaceId: otherShareSpaceId,
        sourceEntityId: ids.entityA2,
        sourceEntityVersionId: ids.entityVersionA2,
        sourceFieldId: ids.fieldA2,
      }),
      readyItemValues({
        id: createSafeId<"shareItem">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        shareSpaceId: expiredShareSpaceId,
        sourceEntityId: ids.entityA1,
        sourceEntityVersionId: createSafeId<"entityVersion">(),
        sourceFieldId: ids.fieldA1,
      }),
      readyItemValues({
        id: createSafeId<"shareItem">(),
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        shareSpaceId: revokedShareSpaceId,
        sourceEntityId: ids.entityA1,
        sourceEntityVersionId: createSafeId<"entityVersion">(),
        sourceFieldId: ids.fieldA1,
      }),
    ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

describe("Share Space RLS", () => {
  test("a share scope sees only its active room, verified recipient, and ready items", async () => {
    const scoped = createShareScopedDb(testDb, activeShareSpaceId, ids.userA1);

    const result = await scoped(async (tx) => ({
      spaces: await tx.select({ id: shareSpaces.id }).from(shareSpaces),
      recipients: await tx
        .select({ userId: shareRecipients.userId })
        .from(shareRecipients),
      items: await tx.select({ id: shareItems.id }).from(shareItems),
    }));

    expect(result.spaces).toEqual([{ id: activeShareSpaceId }]);
    expect(result.recipients).toEqual([{ userId: ids.userA1 }]);
    expect(result.items).toEqual([{ id: readyShareItemId }]);
  });

  test("a share scope grants no workspace, entity, or internal chat visibility", async () => {
    const scoped = createShareScopedDb(testDb, activeShareSpaceId, ids.userA1);

    const counts = await scoped(async (tx) => ({
      workspaces: await tx.$count(workspaces),
      entities: await tx.$count(entities),
      chatThreads: await tx.$count(chatThreads),
    }));

    expect(counts).toEqual({ workspaces: 0, entities: 0, chatThreads: 0 });
  });

  test("the share pin does not leak another active room", async () => {
    const scoped = createShareScopedDb(testDb, activeShareSpaceId, ids.userA1);
    const rows = await scoped((tx) =>
      tx
        .select({ id: shareSpaces.id })
        .from(shareSpaces)
        .where(eq(shareSpaces.id, otherShareSpaceId)),
    );

    expect(rows).toEqual([]);
  });

  test("expired and revoked rooms fail closed", async () => {
    const expired = createShareScopedDb(
      testDb,
      expiredShareSpaceId,
      ids.userA1,
    );
    const revoked = createShareScopedDb(
      testDb,
      revokedShareSpaceId,
      ids.userA1,
    );

    expect(await expired((tx) => tx.$count(shareSpaces))).toBe(0);
    expect(await expired((tx) => tx.$count(shareRecipients))).toBe(0);
    expect(await expired((tx) => tx.$count(shareItems))).toBe(0);
    expect(await revoked((tx) => tx.$count(shareSpaces))).toBe(0);
    expect(await revoked((tx) => tx.$count(shareItems))).toBe(0);
  });

  test("external scope cannot mutate share rows", async () => {
    const scoped = createShareScopedDb(testDb, activeShareSpaceId, ids.userA1);

    const updated = await scoped((tx) =>
      tx
        .update(shareSpaces)
        .set({ name: "Tampered" })
        .where(eq(shareSpaces.id, activeShareSpaceId))
        .returning({ id: shareSpaces.id }),
    );
    const deleted = await scoped((tx) =>
      tx
        .delete(shareItems)
        .where(eq(shareItems.id, readyShareItemId))
        .returning({ id: shareItems.id }),
    );

    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test("internal scope can manage only rooms in its authorized workspace", async () => {
    const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
    const rows = await scoped((tx) =>
      tx.select({ id: shareSpaces.id }).from(shareSpaces),
    );
    const visibleIds = rows.map((row) => row.id);

    expect(visibleIds).toContain(activeShareSpaceId);
    expect(visibleIds).toContain(expiredShareSpaceId);
    expect(visibleIds).toContain(revokedShareSpaceId);
    expect(visibleIds).not.toContain(otherShareSpaceId);
  });
});
