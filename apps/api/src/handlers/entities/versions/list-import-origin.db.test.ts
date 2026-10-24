import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { organization } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { entities, entityVersions, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { documentSourceSchema } from "@/api/lib/document-source";
import { importDocumentSource } from "@/api/lib/uploads/import-origin";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { readVersionsHandler } from "./list";

// A file imported from another system keeps the dates and author that system
// recorded, while the version's own timestamp stays the import's.

let db: TestDatabase;

beforeAll(async () => {
  db = await getTestDb();
}, 300_000);
afterAll(releaseTestDb);

test("an imported document keeps its original dates and author", async () => {
  const organizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Document import",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Matter",
    reference: "IMP-1",
  });
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: "Lease 2019.docx",
  });

  // The presign body as an import client sends it, offsets and all.
  const source = importDocumentSource({
    source: "file-share",
    id: "\\\\files\\leases\\Lease 2019.docx",
    createdAt: "2019-03-04T09:15:00+01:00",
    modifiedAt: "2021-11-30T18:45:12+01:00",
    authorName: "M. Dvořák",
  });
  expect(v.is(documentSourceSchema, source)).toBe(true);
  await db.insert(entityVersions).values({
    id: versionId,
    entityId,
    workspaceId,
    versionNumber: 1,
    source,
  });
  await db
    .update(entities)
    .set({ currentVersionId: versionId })
    .where(eq(entities.id, entityId));

  const listed = await Result.gen(() =>
    readVersionsHandler({
      safeDb: asTestRaw<SafeDb>(
        createSafeDb(db, [workspaceId], organizationId, null),
      ),
      workspaceId,
      entityId,
      before: undefined,
      filePropertyId: undefined,
    }),
  );
  if (Result.isError(listed)) {
    panic("Listing the imported document's versions failed", {
      cause: listed.error,
    });
  }
  const [version] = listed.value.versions;
  expect(version?.sourceKind).toBe("import");
  expect(version?.importOrigin).toEqual({
    source: "file-share",
    id: "\\\\files\\leases\\Lease 2019.docx",
    createdAt: "2019-03-04T08:15:00Z",
    modifiedAt: "2021-11-30T17:45:12Z",
    authorName: "M. Dvořák",
  });
  // The original modification date is provenance, not the version's clock.
  expect(version?.createdAt).not.toBe(version?.importOrigin?.modifiedAt);

  await db.delete(organization).where(eq(organization.id, organizationId));
});

test("an import without dates or author keeps nulls, not guesses", () => {
  expect(importDocumentSource({ source: "archive-zip" })).toEqual({
    kind: "import",
    externalSource: "archive-zip",
    externalId: null,
    originalCreatedAt: null,
    originalModifiedAt: null,
    originalAuthorName: null,
  });
});
