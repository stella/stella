/**
 * An `ai` step with `includeDocuments` must not silently proceed when a selected
 * input has no extracted content (extraction pending/failed, or a non-extraction
 * entity surfaced by the summaries picker). Producing legal output from an
 * incomplete document set is not acceptable, so the step fails and names the
 * unavailable inputs. Driven against a real (PGlite) database under RLS.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import {
  entities,
  entityVersions,
  extractedContent,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  FlowStepError,
  loadInputDocuments,
} from "@/api/lib/flows/flow-executor";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createDryScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

setDefaultTimeout(60_000);

const testDb: TestDatabase = await getTestDb();

describe("loadInputDocuments", () => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const extractedEntityId = createSafeId<"entity">();
  const versionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const propertyId = createSafeId<"property">();
  const fileId = Bun.randomUUIDv7();
  const pendingEntityId = createSafeId<"entity">();
  let fake: FakeS3;

  beforeAll(async () => {
    fake = startFakeS3();
    await testDb.insert(organization).values({
      id: organizationId,
      name: "Docs Org",
      slug: `docs-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(user).values({
      id: userId,
      name: "Docs User",
      email: `${userId}@test.local`,
    });
    await testDb.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Docs matter",
      reference: "DOCS",
    });
    await testDb.insert(entities).values([
      {
        id: extractedEntityId,
        workspaceId,
        name: "Available doc",
        createdBy: userId,
      },
      {
        id: pendingEntityId,
        workspaceId,
        name: "Pending doc",
        createdBy: userId,
      },
    ]);
    await testDb.insert(entityVersions).values({
      id: versionId,
      entityId: extractedEntityId,
      workspaceId,
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: versionId })
      .where(eq(entities.id, extractedEntityId));
    await testDb.insert(properties).values({
      id: propertyId,
      workspaceId,
      name: "File",
      status: "fresh",
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "manual-input" },
    });
    await testDb.insert(fields).values({
      id: fieldId,
      propertyId,
      workspaceId,
      entityVersionId: versionId,
      content: {
        version: 1,
        type: "file",
        id: fileId,
        fileName: "agreement.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 3,
        encrypted: false,
        sha256Hex: "a".repeat(64),
        pdfFileId: null,
      },
    });
    await testDb.insert(extractedContent).values({
      entityId: extractedEntityId,
      organizationId,
      workspaceId,
      ciphertext: Buffer.from([1, 2, 3]),
      iv: Buffer.from([4, 5, 6]),
      charCount: 3,
      sourceEntityVersionId: versionId,
      sourceFieldId: fieldId,
      sourceFileId: fileId,
      sourceSha256Hex: "a".repeat(64),
    });
  });

  afterAll(async () => {
    fake.stop();
    await releaseTestDb();
  });

  const scopedDb = () =>
    asTestRaw<Parameters<typeof loadInputDocuments>[0]>(
      createScopedDb(testDb, [workspaceId], organizationId, userId),
    );

  test("fails the step and names inputs whose content is unavailable", async () => {
    const caught = await loadInputDocuments(
      scopedDb(),
      organizationId,
      [workspaceId],
      [extractedEntityId, pendingEntityId],
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(FlowStepError);
    if (caught instanceof FlowStepError) {
      expect(caught.message).toContain("Pending doc");
    }
    // The unavailable input is detected from the database alone. Reading any
    // object before that check would spend a request per input on a step that
    // cannot run, and would surface a store outage as a document failure.
    expect(fake.requests).toEqual([]);
  });

  test("includes only live current-version inputs", async () => {
    await createDryScopedQuery(testDb)(
      [workspaceId],
      organizationId,
      async (tx) => {
        await tx
          .update(entityVersions)
          .set({ deletedAt: new Date() })
          .where(eq(entityVersions.id, versionId));
        const scoped = asTestRaw<Parameters<typeof loadInputDocuments>[0]>(
          async (
            run: (transaction: TestDatabaseTransaction) => Promise<unknown>,
          ) => await run(tx),
        );
        const caught = await loadInputDocuments(
          scoped,
          organizationId,
          [workspaceId],
          [extractedEntityId],
        ).then(
          () => null,
          (error: unknown) => error,
        );
        expect(caught).toBeInstanceOf(FlowStepError);
        if (caught instanceof FlowStepError) {
          expect(caught.message).toContain("Available doc");
        }
        expect(fake.requests).toEqual([]);
      },
      userId,
    );
  });
});
