import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { EML_MIME_TYPE } from "@stll/api-contract/email-mime-types";

import {
  correspondence,
  entities,
  entityVersions,
  fields,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  emlFile,
  GOLDEN_MESSAGE,
} from "@/api/lib/email/inbound/email-file.test-fixture";
import {
  fileUploadedMail,
  retireUploadedMailSource,
} from "@/api/lib/email/inbound/upload";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});
afterAll(releaseRlsFixture);

test("only the current immutable file generation may file or retire uploaded correspondence", async () => {
  const entityId = createSafeId<"entity">();
  const initialVersionId = createSafeId<"entityVersion">();
  const currentVersionId = createSafeId<"entityVersion">();
  const initialFileId = "uploaded-email-generation";
  const currentFileId = "replacement-pdf-generation";
  const scope = {
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    entityId,
  };
  await testDb.insert(entities).values({
    id: entityId,
    workspaceId: ids.wsA1,
    name: "Uploaded letter",
    createdBy: ids.userA1,
  });
  await testDb.insert(entityVersions).values([
    { id: initialVersionId, entityId, workspaceId: ids.wsA1, versionNumber: 1 },
    { id: currentVersionId, entityId, workspaceId: ids.wsA1, versionNumber: 2 },
  ]);
  await testDb.insert(fields).values(
    [
      {
        versionId: initialVersionId,
        fileId: initialFileId,
        mimeType: EML_MIME_TYPE,
      },
      {
        versionId: currentVersionId,
        fileId: currentFileId,
        mimeType: "application/pdf",
      },
    ].map(({ versionId, fileId, mimeType }) => ({
      id: createSafeId<"field">(),
      workspaceId: ids.wsA1,
      entityVersionId: versionId,
      propertyId: ids.filePropertyA1,
      content: {
        type: "file" as const,
        id: fileId,
        mimeType,
        fileName: "letter",
        sizeBytes: 128,
        pdfFileId: null,
        sha256Hex: "a".repeat(64),
        encrypted: false,
        version: 1,
      },
    })),
  );
  await testDb
    .update(entities)
    .set({ currentVersionId: initialVersionId })
    .where(eq(entities.id, entityId));
  const scopedDbForUploader: NonNullable<
    Parameters<typeof fileUploadedMail>[0]["scopedDbForUploader"]
  > = ({ userId }) => createScopedDb(testDb, [ids.wsA1], ids.orgA, userId);
  const scopedDbForSource: NonNullable<
    Parameters<typeof retireUploadedMailSource>[0]["scopedDbForSource"]
  > = () => createScopedDb(testDb, [ids.wsA1], ids.orgA, null);
  const initial = await fileUploadedMail({
    database: testDb,
    scope,
    sourceFileId: initialFileId,
    mimeType: EML_MIME_TYPE,
    bytes: emlFile(GOLDEN_MESSAGE),
    scopedDbForUploader,
    scopedDbForSource,
  });
  expect(initial.isOk() && initial.value.status).toBe("filed");
  const records = () =>
    testDb
      .select({ id: correspondence.id })
      .from(correspondence)
      .where(eq(correspondence.sourceEntityId, entityId));
  expect(await records()).toHaveLength(1);
  await testDb
    .update(entities)
    .set({ currentVersionId })
    .where(eq(entities.id, entityId));
  for (const sourceFileId of [initialFileId, undefined]) {
    const stale = await fileUploadedMail({
      database: testDb,
      scope,
      ...(sourceFileId === undefined ? {} : { sourceFileId }),
      mimeType: EML_MIME_TYPE,
      bytes: new ArrayBuffer(0),
      scopedDbForUploader,
      scopedDbForSource,
    });
    expect(stale.isOk() && stale.value).toEqual({
      status: "skipped",
      reason: "source_changed",
    });
  }
  const staleCleanup = await retireUploadedMailSource({
    database: testDb,
    scope,
    sourceFileId: initialFileId,
    scopedDbForSource,
  });
  expect(staleCleanup.isOk() && staleCleanup.value).toEqual({
    status: "skipped",
    reason: "source_changed",
  });
  expect(await records()).toHaveLength(1);
  const currentCleanup = await retireUploadedMailSource({
    database: testDb,
    scope,
    sourceFileId: currentFileId,
    scopedDbForSource,
  });
  expect(currentCleanup.isOk() && currentCleanup.value).toEqual({
    status: "skipped",
    reason: "not_email",
  });
  expect(await records()).toEqual([]);
});
