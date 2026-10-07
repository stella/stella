import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
  properties,
  searchDocuments,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { restoreManualOcrRunAfterProjectionLoss } from "@/api/lib/document-processing-manual-ocr-restore";
import { persistManualOcrRun } from "@/api/lib/document-processing-request";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { waitForBlockedPid } from "@/api/tests/helpers/flow-review-gate";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const schedules = (["request", "restore"] as const).flatMap((path) =>
  (["repair", "ocr"] as const).map((first) => ({ path, first })),
);

const seedOcrFixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const propertyId = createSafeId<"property">();
  const sourceFileId = Bun.randomUUIDv7();
  const sourceSha256Hex = "a".repeat(64);
  const cleanup = async () => {
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  };
  try {
    await db.insert(organization).values({
      id: organizationId,
      name: "OCR serialization",
      slug: organizationId,
      createdAt: new Date(),
    });
    await db.insert(user).values({
      id: userId,
      name: "OCR user",
      email: `${userId}@example.test`,
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "OCR matter",
      reference: "OCR",
    });
    await db.insert(entities).values({
      id: entityId,
      workspaceId,
      name: "Current OCR source",
      kind: "document",
    });
    await db
      .insert(entityVersions)
      .values({ id: entityVersionId, entityId, workspaceId, versionNumber: 1 });
    await db
      .update(entities)
      .set({ currentVersionId: entityVersionId })
      .where(eq(entities.id, entityId));
    await db.insert(properties).values({
      id: propertyId,
      workspaceId,
      name: "File",
      content: { type: "file", version: 1 },
      tool: { type: "manual-input", version: 1 },
      status: "fresh",
      system: true,
      kinds: ["document"],
    });
    await db.insert(fields).values({
      id: fieldId,
      workspaceId,
      entityVersionId,
      propertyId,
      content: {
        type: "file",
        version: 1,
        id: sourceFileId,
        sha256Hex: sourceSha256Hex,
        fileName: "source.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        encrypted: false,
        pdfFileId: null,
      },
    });
    return {
      organizationId,
      userId,
      workspaceId,
      source: {
        entityId,
        entityVersionId,
        fieldId,
        sourceFileId,
        sourceSha256Hex,
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("OCR workspace serialization against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test.each(schedules)(
    "$path remains compatible with repair when $first starts first",
    async ({ path, first }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const ocr = openClient({ connection: { statement_timeout: 5000 } });
        const repair = openClient({ connection: { statement_timeout: 5000 } });
        const observer = openClient();
        const fixture = await seedOcrFixture(setup.db);
        const { organizationId, workspaceId, userId, source } = fixture;
        const firstReady = Promise.withResolvers<undefined>();
        const releaseFirst = Promise.withResolvers<undefined>();
        const pending: Promise<void>[] = [];
        try {
          if (path === "restore") {
            await setup.db.insert(documentProcessingRuns).values({
              id: createSafeId<"documentProcessingRun">(),
              organizationId,
              workspaceId,
              ...source,
              kind: "ocr",
              processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
              requestSource: "manual",
              requestedBy: userId,
              status: "failed",
              errorCode: "search_index_failed",
            });
          }
          const ocrPidRows = await ocr.sql<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          const repairPidRows = await repair.sql<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          const ocrPid = ocrPidRows.at(0)?.pid ?? panic("OCR session missing");
          const repairPid =
            repairPidRows.at(0)?.pid ?? panic("Repair session missing");
          const ocrDatabase = {
            transaction: async <T>(run: (tx: Transaction) => Promise<T>) =>
              await ocr.db.transaction(async (tx) => {
                // Pause at the same entity lock the real OCR path acquires.
                await tx
                  .select({ id: entities.id })
                  .from(entities)
                  .where(eq(entities.id, source.entityId))
                  .for("update");
                if (first === "ocr") {
                  firstReady.resolve(undefined);
                  await releaseFirst.promise;
                }
                return await run(tx);
              }),
          };
          const repairDatabase = {
            query: repair.db.query,
            select: repair.db.select.bind(repair.db),
            transaction: async <T>(run: (tx: Transaction) => Promise<T>) =>
              await repair.db.transaction(async (tx) => {
                const result = await run(tx);
                if (first === "repair") {
                  firstReady.resolve(undefined);
                  await releaseFirst.promise;
                }
                return result;
              }),
          };
          const runOcr = async () => {
            switch (path) {
              case "request": {
                const result = await persistManualOcrRun({
                  db: ocrDatabase,
                  organizationId,
                  workspaceId,
                  userId,
                  source,
                  recordAuditEvent: async () => undefined,
                });
                expect(result?.status).toBe("queued");
                return;
              }
              case "restore":
                await restoreManualOcrRunAfterProjectionLoss({
                  db: ocrDatabase,
                  organizationId,
                  workspaceId,
                  ...source,
                });
                return;
              default:
                path satisfies never;
            }
          };
          const runRepair = async () =>
            await upsertSearchDocument(source.entityId, {
              database: repairDatabase,
            });
          pending.push(first === "ocr" ? runOcr() : runRepair());
          await withTimeout(async () => await firstReady.promise, {
            label: "OCR repair transaction barrier",
            timeoutMs: 3000,
          });
          pending.push(first === "ocr" ? runRepair() : runOcr());
          await waitForBlockedPid(observer.sql, {
            waitingPid: first === "ocr" ? repairPid : ocrPid,
            holdingPid: first === "ocr" ? ocrPid : repairPid,
          });
          releaseFirst.resolve(undefined);
          const outcomes = await Promise.allSettled(pending);
          expect(outcomes.map(({ status }) => status)).toEqual([
            "fulfilled",
            "fulfilled",
          ]);
          const runs = await setup.db
            .select({ status: documentProcessingRuns.status })
            .from(documentProcessingRuns)
            .where(eq(documentProcessingRuns.entityId, source.entityId));
          expect(runs).toEqual([{ status: "queued" }]);
          expect(
            (
              await setup.db
                .select({ title: searchDocuments.title })
                .from(searchDocuments)
                .where(eq(searchDocuments.entityId, source.entityId))
            ).at(0)?.title,
          ).toBe("Current OCR source");
        } finally {
          releaseFirst.resolve(undefined);
          await Promise.allSettled(pending);
          try {
            await Promise.all(pending);
          } finally {
            await fixture.cleanup();
          }
        }
      });
    },
    15_000,
  );

  test("manual OCR still serializes workspace status changes", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const setup = openClient();
      const ocr = openClient({ connection: { statement_timeout: 5000 } });
      const statusWriter = openClient({
        connection: { statement_timeout: 5000 },
      });
      const observer = openClient();
      const fixture = await seedOcrFixture(setup.db);
      const audited = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const pending: Promise<unknown>[] = [];
      try {
        const ocrPidRows = await ocr.sql<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const writerPidRows = await statusWriter.sql<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const ocrPid = ocrPidRows.at(0)?.pid ?? panic("OCR session missing");
        const writerPid =
          writerPidRows.at(0)?.pid ?? panic("Status writer session missing");
        const { organizationId, userId, workspaceId, source } = fixture;
        pending.push(
          persistManualOcrRun({
            db: ocr.db,
            organizationId,
            userId,
            workspaceId,
            source,
            recordAuditEvent: async () => {
              audited.resolve(undefined);
              await release.promise;
            },
          }),
        );
        await withTimeout(async () => await audited.promise, {
          label: "OCR audit transaction barrier",
          timeoutMs: 3000,
        });
        pending.push(
          statusWriter.db
            .update(workspaces)
            .set({ status: "archived" })
            .where(eq(workspaces.id, workspaceId))
            .execute(),
        );
        await waitForBlockedPid(observer.sql, {
          waitingPid: writerPid,
          holdingPid: ocrPid,
        });
        release.resolve(undefined);
        const outcomes = await Promise.allSettled(pending);
        expect(outcomes.map(({ status }) => status)).toEqual([
          "fulfilled",
          "fulfilled",
        ]);
        expect(
          (
            await setup.db
              .select({ status: workspaces.status })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId))
          ).at(0)?.status,
        ).toBe("archived");
        expect(
          (
            await setup.db
              .select({ status: documentProcessingRuns.status })
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.entityId, source.entityId))
          ).at(0)?.status,
        ).toBe("queued");
      } finally {
        release.resolve(undefined);
        await Promise.allSettled(pending);
        try {
          await Promise.all(pending);
        } finally {
          await fixture.cleanup();
        }
      }
    });
  }, 15_000);
}
