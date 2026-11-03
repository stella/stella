import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { entities, entityVersions, fields } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { preflightPdfSigning } from "@/api/lib/files/pdf-signing/handoff-preflight";
import { executeRowsSafeDb } from "@/api/tests/helpers/pglite-rows-scoped-db";
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

afterAll(async () => {
  await releaseRlsFixture();
});

test("rejects the saved field when a newer same-entity version is current", async () => {
  const safeDb = executeRowsSafeDb(
    createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
  const savedField = (
    await testDb
      .select({ content: fields.content })
      .from(fields)
      .where(eq(fields.id, ids.fileFieldA1))
  ).at(0);
  if (savedField?.content.type !== "file") {
    throw new Error("Fixture field A1 is not a file");
  }

  const currentVersionId = createSafeId<"entityVersion">();
  const currentFieldId = createSafeId<"field">();
  const currentContent = {
    ...savedField.content,
    fileName: "agreement-a-current.pdf",
    mimeType: "application/pdf",
  };
  await testDb.insert(entityVersions).values({
    entityId: ids.entityA1,
    id: currentVersionId,
    versionNumber: 2,
    workspaceId: ids.wsA1,
  });
  await testDb.insert(fields).values({
    content: currentContent,
    entityVersionId: currentVersionId,
    id: currentFieldId,
    propertyId: ids.filePropertyA1,
    workspaceId: ids.wsA1,
  });
  await testDb
    .update(entities)
    .set({ currentVersionId })
    .where(eq(entities.id, ids.entityA1));

  try {
    let readFileCalls = 0;
    const result = await preflightPdfSigning({
      entityId: ids.entityA1,
      fieldId: ids.fileFieldA1,
      location: null,
      organizationId: ids.orgA,
      propertyId: ids.filePropertyA1,
      reason: null,
      safeDb,
      stamp: undefined,
      workspaceId: ids.wsA1,
      readFile: async () => {
        readFileCalls += 1;
        throw new Error("stale field must be rejected before reading bytes");
      },
    });

    expect(Result.isError(result) && result.error.code).toBe(
      "pdf_signing_base_version_changed",
    );
    expect(readFileCalls).toBe(0);
    const current = await testDb
      .select({ currentVersionId: entities.currentVersionId })
      .from(entities)
      .where(eq(entities.id, ids.entityA1));
    expect(current.at(0)?.currentVersionId).toBe(currentVersionId);
  } finally {
    await testDb
      .update(entities)
      .set({ currentVersionId: ids.entityVersionA1 })
      .where(eq(entities.id, ids.entityA1));
    await testDb.delete(fields).where(eq(fields.id, currentFieldId));
    await testDb
      .delete(entityVersions)
      .where(eq(entityVersions.id, currentVersionId));
  }
});
