import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  properties,
  shareItems,
  shareSpaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import type { SharePublicationStorage } from "@/api/handlers/share-spaces/share-publisher";
import { publishShareItem } from "@/api/handlers/share-spaces/share-publisher";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let scopedDb: ScopedDb;

const sourceEntityId = createSafeId<"entity">();
const sourceVersionId = createSafeId<"entityVersion">();
const sourcePropertyId = createSafeId<"property">();
const sourceFieldId = createSafeId<"field">();
const sourceFileId = Bun.randomUUIDv7();
const successfulSpaceId = createSafeId<"shareSpace">();
const successfulItemId = createSafeId<"shareItem">();
const failedSpaceId = createSafeId<"shareSpace">();
const failedItemId = createSafeId<"shareItem">();
const SOURCE_SHA = "b".repeat(64);

const shareSpaceValues = (
  id: typeof successfulSpaceId,
  tokenCharacter: string,
) => ({
  id,
  organizationId: ids.orgA,
  workspaceId: ids.wsA1,
  name: "Signed agreement",
  status: "publishing" as const,
  accessTokenHash: tokenCharacter.repeat(64),
  createdBy: ids.userA1,
});

const shareItemValues = (
  id: typeof successfulItemId,
  shareSpaceId: typeof successfulSpaceId,
) => ({
  id,
  organizationId: ids.orgA,
  workspaceId: ids.wsA1,
  shareSpaceId,
  sourceEntityId,
  sourceEntityVersionId: sourceVersionId,
  sourceFieldId,
  displayName: "Signed agreement",
  status: "publishing" as const,
  originalFileName: "agreement.pdf",
  originalMimeType: "application/pdf",
  originalSizeBytes: 2048,
  originalSha256Hex: SOURCE_SHA,
});

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;
    scopedDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    );

    await testDb.insert(properties).values({
      id: sourcePropertyId,
      workspaceId: ids.wsA1,
      name: "File",
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "manual-input" },
      status: "fresh",
    });
    await testDb.insert(entities).values({
      id: sourceEntityId,
      workspaceId: ids.wsA1,
      name: "agreement.pdf",
      displayName: "Signed agreement",
      createdBy: ids.userA1,
    });
    await testDb.insert(entityVersions).values({
      id: sourceVersionId,
      workspaceId: ids.wsA1,
      entityId: sourceEntityId,
      versionNumber: 3,
      stamp: "2026/001/003.v3",
      verificationCode: "A1B2C3D4",
      createdBy: ids.userA1,
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: sourceVersionId })
      .where(eq(entities.id, sourceEntityId));
    await testDb.insert(fields).values({
      id: sourceFieldId,
      workspaceId: ids.wsA1,
      propertyId: sourcePropertyId,
      entityVersionId: sourceVersionId,
      content: {
        version: 1,
        type: "file",
        id: sourceFileId,
        fileName: "agreement.pdf",
        mimeType: "application/pdf",
        sizeBytes: 2048,
        encrypted: false,
        sha256Hex: SOURCE_SHA,
        pdfFileId: null,
        pdfDerivative: { status: "not-required" },
        thumbnailFileId: null,
        thumbnailDerivative: { status: "not-required" },
      },
    });
    await testDb
      .insert(shareSpaces)
      .values([
        shareSpaceValues(successfulSpaceId, "5"),
        shareSpaceValues(failedSpaceId, "6"),
      ]);
    await testDb
      .insert(shareItems)
      .values([
        shareItemValues(successfulItemId, successfulSpaceId),
        shareItemValues(failedItemId, failedSpaceId),
      ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

const createAuditCapture = () => {
  const events: AuditEvent[] = [];
  const recorder: AuditRecorder = async (_tx, event) => {
    events.push(...(Array.isArray(event) ? event : [event]));
  };
  return { events, recorder };
};

describe("Share Space publisher", () => {
  test("copies a PDF snapshot before atomically activating its item and room", async () => {
    const copies: { source: string; target: string; mimeType: string }[] = [];
    const storage: SharePublicationStorage = {
      copy: async (source, target, mimeType) => {
        copies.push({ source, target, mimeType });
      },
      read: async () => new ArrayBuffer(0),
      write: async () => {},
      delete: async () => {},
    };
    const audit = createAuditCapture();

    const result = await publishShareItem({
      scopedDb,
      recordAuditEvent: audit.recorder,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      shareSpaceId: successfulSpaceId,
      shareItemId: successfulItemId,
      storage,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(copies).toHaveLength(2);
    expect(copies.map(({ target }) => target)).toEqual([
      expect.stringContaining(`/items/${successfulItemId}/original.pdf`),
      expect.stringContaining(`/items/${successfulItemId}/display.pdf`),
    ]);

    const item = await testDb.query.shareItems.findFirst({
      where: { id: { eq: successfulItemId } },
    });
    const space = await testDb.query.shareSpaces.findFirst({
      where: { id: { eq: successfulSpaceId } },
    });
    expect(item).toMatchObject({
      status: "ready",
      displayMimeType: "application/pdf",
      failureCode: null,
    });
    expect(item?.originalStorageKey).toContain(
      `/items/${successfulItemId}/original.pdf`,
    );
    expect(item?.displayStorageKey).toContain(
      `/items/${successfulItemId}/display.pdf`,
    );
    expect(item?.publishedAt).toBeInstanceOf(Date);
    expect(space?.status).toBe("active");
    expect(audit.events.map(({ resourceType }) => resourceType)).toEqual([
      "share_item",
      "share_space",
    ]);
  });

  test("cleans copied assets and fails closed when the display copy fails", async () => {
    const copiedTargets: string[] = [];
    const deletedKeys: string[][] = [];
    const storage: SharePublicationStorage = {
      copy: async (_source, target) => {
        if (copiedTargets.length === 1) {
          throw new Error("display copy failed");
        }
        copiedTargets.push(target);
      },
      read: async () => new ArrayBuffer(0),
      write: async () => {},
      delete: async (keys) => {
        deletedKeys.push(keys);
      },
    };
    const audit = createAuditCapture();

    const result = await publishShareItem({
      scopedDb,
      recordAuditEvent: audit.recorder,
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      shareSpaceId: failedSpaceId,
      shareItemId: failedItemId,
      storage,
    });

    expect(Result.isError(result)).toBe(true);
    expect(deletedKeys).toEqual([copiedTargets]);
    const item = await testDb.query.shareItems.findFirst({
      where: { id: { eq: failedItemId } },
    });
    const space = await testDb.query.shareSpaces.findFirst({
      where: { id: { eq: failedSpaceId } },
    });
    expect(item).toMatchObject({
      status: "failed",
      failureCode: "copy_failed",
      originalStorageKey: null,
      displayStorageKey: null,
    });
    expect(space?.status).toBe("draft");
    expect(audit.events.at(0)).toMatchObject({
      resourceType: "share_space",
      metadata: { publicationFailure: "copy_failed" },
    });
  });
});
