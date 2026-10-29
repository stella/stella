import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  extractedContent,
  fields,
  workspaces,
} from "@/api/db/schema";
import { deleteEntityVersionHandler } from "@/api/handlers/entities/versions/delete";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  isCurrentDeadlineSource,
  loadCurrentDeadlineSource,
  loadCurrentExtractedContents,
  loadCurrentExtractedSources,
  loadCurrentOcrExport,
} from "@/api/lib/document-content-provenance";
import { authorizedWorkspaceIds } from "@/api/lib/workspaces/authorized-workspace-ids";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import {
  createDryScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

const ids = createTestIds();
let database: TestDatabase;

beforeAll(async () => {
  database = await getTestDb();
  await setupRlsTestData(database, ids);
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

const checkedWorkspaceIds = async (
  tx: TestDatabaseTransaction,
  workspaceIds: readonly SafeId<"workspace">[],
) =>
  (
    await authorizedWorkspaceIds(tx, {
      organizationId: ids.orgA,
      workspaceIds,
    })
  ).unwrap();

const readCurrent = async (tx: TestDatabaseTransaction) =>
  await loadCurrentExtractedContents(tx, {
    entityIds: [ids.entityA1, ids.entityA2, ids.entityB1],
    organizationId: ids.orgA,
    workspaceIds: await checkedWorkspaceIds(tx, [ids.wsA1]),
  });

test("owner connection is not a user-facing content reader", async () => {
  const workspaceIds = (
    await authorizedWorkspaceIds(rootDb, {
      organizationId: ids.orgA,
      workspaceIds: [],
    })
  ).unwrap();
  // @ts-expect-error The owner connection is intentionally not an RLS transaction.
  void loadCurrentExtractedContents(rootDb, {
    entityIds: [],
    organizationId: ids.orgA,
    workspaceIds,
  });
});

const inMatter = async (run: (tx: TestDatabaseTransaction) => Promise<void>) =>
  await createDryScopedQuery(database)([ids.wsA1], ids.orgA, run, ids.userA1);

test("current content follows organization and matter scope", async () => {
  await inMatter(async (tx) => {
    const rows = await readCurrent(tx);
    expect(rows.map(({ entityId }) => entityId)).toEqual([ids.entityA1]);
    expect(rows.at(0)?.text).toBe("extracted text a1");
    expect(
      await loadCurrentExtractedContents(tx, {
        entityIds: [ids.entityA1],
        organizationId: ids.orgA,
        workspaceIds: await checkedWorkspaceIds(tx, [ids.wsA2]),
      }),
    ).toEqual([]);
    expect(
      await loadCurrentExtractedContents(tx, {
        entityIds: [ids.entityA1],
        organizationId: ids.orgB,
        workspaceIds: await checkedWorkspaceIds(tx, [ids.wsA1]),
      }),
    ).toEqual([]);
  });
});

test("current sources stay available when a document's text cannot be decrypted", async () => {
  const original =
    (
      await database
        .select({ ciphertext: extractedContent.ciphertext })
        .from(extractedContent)
        .where(eq(extractedContent.entityId, ids.entityA1))
    ).at(0) ?? panic("Fixture extracted content is missing");
  await database
    .update(extractedContent)
    .set({ ciphertext: Buffer.from("not a ciphertext") })
    .where(eq(extractedContent.entityId, ids.entityA1));
  try {
    await inMatter(async (tx) => {
      const options = {
        entityIds: [ids.entityA1],
        organizationId: ids.orgA,
        workspaceIds: await checkedWorkspaceIds(tx, [ids.wsA1]),
      };
      // Availability needs only provenance: it never decrypts.
      const sources = await loadCurrentExtractedSources(tx, options);
      expect(sources.map(({ entityId }) => entityId)).toEqual([ids.entityA1]);
      expect(sources.at(0)).not.toHaveProperty("text");
      expect(sources.at(0)).not.toHaveProperty("ciphertext");
      expect(
        await loadCurrentExtractedContents(tx, options).then(
          () => "read",
          () => "refused",
        ),
      ).toBe("refused");
    });
  } finally {
    await database
      .update(extractedContent)
      .set({ ciphertext: original.ciphertext })
      .where(eq(extractedContent.entityId, ids.entityA1));
  }
});

test("checked matter ids stay immutable", async () => {
  await inMatter(async (tx) => {
    const workspaceIds = await checkedWorkspaceIds(tx, [ids.wsA1]);
    expect(() => {
      // @ts-expect-error Checked matter ids expose no mutating methods.
      workspaceIds.push(ids.wsA2);
    }).toThrow(TypeError);
    expect([...workspaceIds]).toEqual([ids.wsA1]);
  });
});

test("the required matter list narrows an otherwise authorized transaction", async () => {
  await createDryScopedQuery(database)(
    [ids.wsA1, ids.wsA2],
    ids.orgA,
    async (tx) => {
      expect(
        await loadCurrentExtractedContents(tx, {
          entityIds: [ids.entityA1],
          organizationId: ids.orgA,
          workspaceIds: await checkedWorkspaceIds(tx, [ids.wsA2]),
        }),
      ).toEqual([]);
    },
    ids.userAdmin,
  );
});

test.each([
  "compat search",
  "compat fetch",
  "cross-matter read",
  "template prefill",
  "flows",
  "OCR export",
])("%s returns extracted text only from an authorized matter", async () => {
  await inMatter(async (tx) => {
    const rows = await loadCurrentExtractedContents(tx, {
      entityIds: [ids.entityA1, ids.entityA2],
      organizationId: ids.orgA,
      workspaceIds: await checkedWorkspaceIds(tx, [ids.wsA1]),
    });
    expect(rows.map(({ entityId }) => entityId)).toEqual([ids.entityA1]);
    expect(rows.at(0)?.text).toBe("extracted text a1");
  });
});

test.each([
  "compat search",
  "compat fetch",
  "cross-matter read",
  "template prefill",
  "flows",
  "OCR export",
])("%s drops a requested matter the caller cannot read", async () => {
  await inMatter(async (tx) => {
    const workspaceIds = await checkedWorkspaceIds(tx, [ids.wsA2]);
    expect([...workspaceIds]).toEqual([]);
    expect(
      await loadCurrentExtractedContents(tx, {
        entityIds: [ids.entityA2],
        organizationId: ids.orgA,
        workspaceIds,
      }),
    ).toEqual([]);
  });
});

test.each([
  {
    name: "version",
    patch: { sourceEntityVersionId: createSafeId<"entityVersion">() },
  },
  { name: "field", patch: { sourceFieldId: ids.fieldA1 } },
  { name: "file", patch: { sourceFileId: Bun.randomUUIDv7() } },
  { name: "digest", patch: { sourceSha256Hex: "c".repeat(64) } },
])("current content requires matching $name provenance", async ({ patch }) => {
  await inMatter(async (tx) => {
    expect(await readCurrent(tx)).toHaveLength(1);
    if (patch.sourceEntityVersionId) {
      await tx.insert(entityVersions).values({
        id: patch.sourceEntityVersionId,
        workspaceId: ids.wsA1,
        entityId: ids.entityA1,
        versionNumber: 2,
      });
    }
    await tx
      .update(extractedContent)
      .set(patch)
      .where(eq(extractedContent.entityId, ids.entityA1));
    expect(await readCurrent(tx)).toEqual([]);
  });
});

test("current content requires a live current version and matter", async () => {
  await inMatter(async (tx) => {
    expect(await readCurrent(tx)).toHaveLength(1);
    await tx
      .update(entityVersions)
      .set({ deletedAt: new Date() })
      .where(eq(entityVersions.id, ids.entityVersionA1));
    expect(await readCurrent(tx)).toEqual([]);
    await tx
      .update(entityVersions)
      .set({ deletedAt: null })
      .where(eq(entityVersions.id, ids.entityVersionA1));
    expect(await readCurrent(tx)).toHaveLength(1);
    await tx
      .update(workspaces)
      .set({ status: "deleting" })
      .where(eq(workspaces.id, ids.wsA1));
    expect(await readCurrent(tx)).toEqual([]);
  });
});

test.each(["exact", "legacy"] as const)(
  "current content follows promotion for %s provenance",
  async (provenance) => {
    await inMatter(async (tx) => {
      expect(await readCurrent(tx)).toHaveLength(1);
      const olderVersionId = createSafeId<"entityVersion">();
      const olderFieldId = createSafeId<"field">();
      const olderFileId = Bun.randomUUIDv7();
      await tx
        .update(entityVersions)
        .set({ versionNumber: 2 })
        .where(eq(entityVersions.id, ids.entityVersionA1));
      await tx.insert(entityVersions).values({
        id: olderVersionId,
        entityId: ids.entityA1,
        workspaceId: ids.wsA1,
        versionNumber: 1,
        createdAt: new Date("2020-01-01T00:00:00Z"),
      });
      await tx.insert(fields).values({
        id: olderFieldId,
        entityVersionId: olderVersionId,
        propertyId: ids.filePropertyA1,
        workspaceId: ids.wsA1,
        content: {
          version: 1,
          type: "file",
          id: olderFileId,
          fileName: "agreement.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 1024,
          encrypted: false,
          sha256Hex: "d".repeat(64),
          pdfFileId: null,
        },
      });
      if (provenance === "legacy") {
        await tx
          .update(extractedContent)
          .set({
            extractedAt: new Date("2099-01-01T00:00:00Z"),
            sourceEntityVersionId: null,
            sourceFieldId: null,
            sourceFileId: null,
            sourceSha256Hex: null,
          })
          .where(eq(extractedContent.entityId, ids.entityA1));
        const legacyRows = await readCurrent(tx);
        expect(legacyRows).toHaveLength(1);
        expect(legacyRows.at(0)?.sourceFieldId).toBe(ids.fileFieldA1);
      }
      await tx
        .update(entities)
        .set({ currentVersionId: olderVersionId })
        .where(eq(entities.id, ids.entityA1));
      await tx
        .update(entityVersions)
        .set({ deletedAt: new Date() })
        .where(eq(entityVersions.id, ids.entityVersionA1));
      expect(await readCurrent(tx)).toEqual([]);
      await tx
        .update(extractedContent)
        .set({
          sourceEntityVersionId: olderVersionId,
          sourceFieldId: olderFieldId,
          sourceFileId: olderFileId,
          sourceSha256Hex: "d".repeat(64),
        })
        .where(eq(extractedContent.entityId, ids.entityA1));
      expect(await readCurrent(tx)).toHaveLength(1);
    });
  },
);

test.each(["exact", "legacy"] as const)(
  "version deletion commits promotion and content cleanup for %s provenance",
  async (provenance) => {
    const runId = createSafeId<"documentProcessingRun">();
    const inserted = await database
      .insert(documentProcessingRuns)
      .values({
        id: runId,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
        entityId: ids.entityA1,
        entityVersionId: ids.entityVersionA1,
        fieldId: ids.fileFieldA1,
        sourceFileId: ids.fileObjectA1,
        sourceSha256Hex: "a".repeat(64),
        kind: "ocr",
        requestSource: "upload",
        status: "succeeded",
      })
      .returning();
    const run = inserted.at(0);
    expect(run).toBeDefined();
    if (!run) {
      return;
    }
    await inMatter(async (tx) => {
      const olderVersionId = createSafeId<"entityVersion">();
      await tx
        .update(entityVersions)
        .set({ versionNumber: 2 })
        .where(eq(entityVersions.id, ids.entityVersionA1));
      await tx.insert(entityVersions).values({
        id: olderVersionId,
        entityId: ids.entityA1,
        workspaceId: ids.wsA1,
        versionNumber: 1,
      });
      await tx
        .update(extractedContent)
        .set({
          ocrRunId: runId,
          ocrProcessorVersion: 1,
          ocrPayloadCiphertext: Buffer.from("page geometry"),
          ocrPayloadIv: Buffer.alloc(12),
        })
        .where(eq(extractedContent.entityId, ids.entityA1));
      const exportOptions = {
        authorizedWorkspaceIds: await checkedWorkspaceIds(tx, [ids.wsA1]),
        db: tx,
        fieldId: ids.fileFieldA1,
        organizationId: ids.orgA,
        workspaceId: ids.wsA1,
      };
      expect(await loadCurrentOcrExport(exportOptions)).not.toBeNull();
      expect(
        await loadCurrentDeadlineSource(tx, "deadline-scout", run),
      ).not.toBeNull();
      expect(await isCurrentDeadlineSource(tx, run)).toBe(true);
      if (provenance === "legacy") {
        await tx
          .update(extractedContent)
          .set({
            extractedAt: new Date("2099-01-01T00:00:00Z"),
            sourceEntityVersionId: null,
            sourceFieldId: null,
            sourceFileId: null,
            sourceSha256Hex: null,
          })
          .where(eq(extractedContent.entityId, ids.entityA1));
      }
      expect(await readCurrent(tx)).toHaveLength(1);
      const result = await Result.gen(() =>
        deleteEntityVersionHandler({
          safeDb: asTestRaw<SafeDb>(
            async (
              execute: (
                transaction: TestDatabaseTransaction,
              ) => Promise<unknown>,
            ) => await Result.tryPromise(async () => await execute(tx)),
          ),
          workspaceId: ids.wsA1,
          entityId: ids.entityA1,
          versionId: ids.entityVersionA1,
          deletedByUserId: ids.userA1,
          recordAuditEvent: async () => undefined,
          processPromotedVersion: async () => undefined,
        }),
      );
      expect(result.isOk()).toBe(true);
      const entity = await tx.query.entities.findFirst({
        where: { id: { eq: ids.entityA1 } },
        columns: { currentVersionId: true },
      });
      expect(entity?.currentVersionId).toBe(olderVersionId);
      const version = await tx.query.entityVersions.findFirst({
        where: { id: { eq: ids.entityVersionA1 } },
        columns: { deletedAt: true },
      });
      expect(version?.deletedAt).toBeInstanceOf(Date);
      const contentCount = await tx
        .select({ entityId: extractedContent.entityId })
        .from(extractedContent)
        .where(eq(extractedContent.entityId, ids.entityA1));
      expect(contentCount).toEqual([]);
      expect(await readCurrent(tx)).toEqual([]);
      expect(await loadCurrentOcrExport(exportOptions)).toBeNull();
      expect(
        await loadCurrentDeadlineSource(tx, "deadline-scout", run),
      ).toBeNull();
      expect(await isCurrentDeadlineSource(tx, run)).toBe(false);
    });
    await database
      .delete(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, runId));
  },
);
