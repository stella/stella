import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";

import { organization, user } from "@/api/db/auth-schema";
import type { rootDb, Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  extractedContent,
  fields,
  organizationSettings,
  properties,
  searchDocuments,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { requestAutomaticDocumentOcr } from "@/api/lib/document-processing-automatic-request";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { restoreManualOcrRunAfterProjectionLoss } from "@/api/lib/document-processing-manual-ocr-restore";
import {
  processDocumentProcessingRun,
  persistMissingNativeExtractionRuns,
  persistOcrProjection,
} from "@/api/lib/document-processing-queue";
import { persistManualOcrRun } from "@/api/lib/document-processing-request";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { waitForBlockedPid } from "@/api/tests/helpers/flow-review-gate";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
    const content = {
      type: "file" as const,
      version: 1 as const,
      id: sourceFileId,
      sha256Hex: sourceSha256Hex,
      fileName: "source.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
      encrypted: false,
      pdfFileId: null,
    };
    await db.insert(fields).values({
      id: fieldId,
      workspaceId,
      entityVersionId,
      propertyId,
      content,
    });
    return {
      organizationId,
      userId,
      workspaceId,
      content,
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

type SourceBarrierOptions = {
  ready: () => void;
  release: Promise<undefined>;
};

const withSourceBarrier = (tx: Transaction, options: SourceBarrierOptions) => {
  let paused = false;
  const pause = async (query: unknown) => {
    const rows = await query;
    if (!paused) {
      paused = true;
      options.ready();
      await options.release;
    }
    return rows;
  };
  // Wrap fluent builders, retaining their receivers and real execution. Only
  // the first UPDATE lock is the source fence, never a parent KEY SHARE query.
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get: (object, key) => {
        const member: unknown = Reflect.get(object, key);
        if (typeof member !== "function") {
          return member;
        }
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(member, object, args);
          if (key === "for" && args.at(0) === "update") {
            return pause(result);
          }
          if (
            [
              "select",
              "from",
              "innerJoin",
              "where",
              "limit",
              "orderBy",
            ].includes(String(key)) &&
            typeof result === "object" &&
            result !== null
          ) {
            return wrap(result);
          }
          return result;
        };
      },
    });
  return wrap(tx);
};

const queuePaths = ["projection", "dispatch", "native-repair"] as const;
type QueuePath = (typeof queuePaths)[number];
type OcrFixture = Awaited<ReturnType<typeof seedOcrFixture>>;

type RunQueueWriterOptions = {
  path: QueuePath;
  first: "deletion" | "ocr";
  database: typeof rootDb;
  fixture: OcrFixture;
  run: typeof documentProcessingRuns.$inferSelect;
  claimToken: string;
};

const runQueueWriter = async ({
  path,
  first,
  database,
  fixture,
  run,
  claimToken,
}: RunQueueWriterOptions) => {
  const { organizationId, workspaceId, source, content } = fixture;
  switch (path) {
    case "projection": {
      const result = await persistOcrProjection({
        database,
        run,
        claimToken,
        ciphertext: Buffer.from("text"),
        iv: Buffer.alloc(12),
        ocrPayloadCiphertext: Buffer.from("payload"),
        ocrPayloadIv: Buffer.alloc(12),
        pageCount: 1,
        textLength: 4,
      });
      expect(result).toBe(first === "ocr" ? "persisted" : "source_cancelled");
      return;
    }
    case "dispatch":
      await processDocumentProcessingRun(
        database,
        run.id,
        new AbortController().signal,
      );
      return;
    case "native-repair": {
      const result = await persistMissingNativeExtractionRuns(
        [
          {
            organizationId,
            workspaceId,
            entityId: source.entityId,
            entityVersionId: source.entityVersionId,
            fieldId: source.fieldId,
            content,
          },
        ],
        database,
      );
      if (first === "deletion") {
        expect(result).toEqual([]);
        return;
      }
      expect(result).toHaveLength(1);
      expect(result.at(0)).toBeDefined();
      return;
    }
    default:
      path satisfies never;
      return panic("Unknown queue writer");
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

  const deletionSchedules = (
    ["request", "restore", "automatic"] as const
  ).flatMap((path) =>
    (["workspace", "organization"] as const).flatMap((parent) =>
      (["deletion", "ocr"] as const).map((first) => ({ path, parent, first })),
    ),
  );
  test.each(deletionSchedules)(
    "$path and $parent deletion serialize when $first starts first",
    async ({ path, parent, first }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const ocr = openClient({ connection: { statement_timeout: 5000 } });
        const deletion = openClient({
          connection: { statement_timeout: 5000 },
        });
        const observer = openClient();
        const fixture = await seedOcrFixture(setup.db);
        const { organizationId, workspaceId, userId, source } = fixture;
        const ready = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const pending: Promise<void>[] = [];
        try {
          await setup.db.insert(organizationSettings).values({
            organizationId,
            documentProcessingMode: "searchable-text",
          });
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
          const ocrPid =
            (
              await ocr.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
            ).at(0)?.pid ?? panic("OCR session missing");
          const deletionPid =
            (
              await deletion.sql<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`
            ).at(0)?.pid ?? panic("Deletion session missing");
          const ocrDatabase = {
            transaction: async <T>(run: (tx: Transaction) => Promise<T>) =>
              await ocr.db.transaction(async (tx) => {
                const result = await run(tx);
                if (first === "ocr") {
                  expect(
                    await tx
                      .select({ status: documentProcessingRuns.status })
                      .from(documentProcessingRuns)
                      .where(
                        eq(documentProcessingRuns.entityId, source.entityId),
                      ),
                  ).toEqual([{ status: "queued" }]);
                  ready.resolve(undefined);
                  await release.promise;
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
                if (first === "deletion") {
                  expect(result).toBeNull();
                } else {
                  expect(result?.status).toBe("queued");
                }
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
              case "automatic":
                await requestAutomaticDocumentOcr({
                  db: ocrDatabase,
                  organizationId,
                  workspaceId,
                  ...source,
                  requestSource: "upload",
                });
                return;
              default:
                path satisfies never;
            }
          };
          const runDeletion = async () => {
            await deletion.db.transaction(async (tx) => {
              if (parent === "organization") {
                await tx
                  .select({ id: organization.id })
                  .from(organization)
                  .where(eq(organization.id, organizationId))
                  .for("update");
              } else {
                await tx
                  .select({ id: workspaces.id })
                  .from(workspaces)
                  .where(eq(workspaces.id, workspaceId))
                  .for("update");
              }
              if (first === "deletion") {
                ready.resolve(undefined);
                await release.promise;
              }
              if (parent === "organization") {
                await tx
                  .delete(organization)
                  .where(eq(organization.id, organizationId));
              } else {
                await tx
                  .delete(workspaces)
                  .where(eq(workspaces.id, workspaceId));
              }
            });
          };
          pending.push(first === "deletion" ? runDeletion() : runOcr());
          await withTimeout(async () => await ready.promise, {
            label: "OCR deletion transaction barrier",
            timeoutMs: 3000,
          });
          pending.push(first === "deletion" ? runOcr() : runDeletion());
          // Observe the lock wait before allowing deletion to cascade to children.
          await waitForBlockedPid(observer.sql, {
            waitingPid: first === "deletion" ? ocrPid : deletionPid,
            holdingPid: first === "deletion" ? deletionPid : ocrPid,
          });
          release.resolve(undefined);
          const outcomes = await Promise.allSettled(pending);
          expect(outcomes.map(({ status }) => status)).toEqual([
            "fulfilled",
            "fulfilled",
          ]);
          expect(
            await setup.db
              .select({ id: documentProcessingRuns.id })
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.workspaceId, workspaceId)),
          ).toEqual([]);
          expect(
            await setup.db
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.workspaceId, workspaceId)),
          ).toEqual([]);
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
    },
    15_000,
  );
  const queueDeletionSchedules = queuePaths.flatMap((path) =>
    (["workspace", "organization"] as const).flatMap((parent) =>
      (["deletion", "ocr"] as const).map((first) => ({ path, parent, first })),
    ),
  );
  test.each(queueDeletionSchedules)(
    "queue $path and $parent deletion serialize when $first starts first",
    async ({ path, parent, first }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const ocr = openClient({ connection: { statement_timeout: 5000 } });
        const deletion = openClient({
          connection: { statement_timeout: 5000 },
        });
        const observer = openClient();
        const fixture = await seedOcrFixture(setup.db);
        const { organizationId, workspaceId, source } = fixture;
        const ready = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const pending: Promise<void>[] = [];
        const claimToken = Bun.randomUUIDv7();
        try {
          const runRows = await setup.db
            .insert(documentProcessingRuns)
            .values({
              id: createSafeId<"documentProcessingRun">(),
              organizationId,
              workspaceId,
              ...source,
              kind: "ocr",
              processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
              requestSource: "manual",
              requestedBy: fixture.userId,
              status: path === "projection" ? "running" : "queued",
              claimedBy: path === "projection" ? claimToken : null,
            })
            .returning();
          const run = runRows.at(0) ?? panic("Queue fixture run missing");
          if (path === "native-repair") {
            await setup.db
              .delete(documentProcessingRuns)
              .where(eq(documentProcessingRuns.id, run.id));
          }
          const ocrPid =
            (
              await ocr.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
            ).at(0)?.pid ?? panic("OCR session missing");
          const deletionPid =
            (
              await deletion.sql<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`
            ).at(0)?.pid ?? panic("Deletion session missing");
          const database = asTestRaw<typeof rootDb>({
            transaction: async <T>(
              operation: (tx: Transaction) => Promise<T>,
            ) =>
              await ocr.db.transaction(async (tx) => {
                const result = await operation(
                  first === "ocr"
                    ? withSourceBarrier(tx, {
                        ready: () => {
                          ready.resolve(undefined);
                          return;
                        },
                        release: release.promise,
                      })
                    : tx,
                );
                if (first === "ocr") {
                  const rows = await tx
                    .select({
                      id: documentProcessingRuns.id,
                      status: documentProcessingRuns.status,
                      kind: documentProcessingRuns.kind,
                      requestSource: documentProcessingRuns.requestSource,
                      claimedBy: documentProcessingRuns.claimedBy,
                      attemptCount: documentProcessingRuns.attemptCount,
                    })
                    .from(documentProcessingRuns)
                    .where(
                      eq(documentProcessingRuns.entityId, source.entityId),
                    );
                  expect(rows).toEqual([
                    {
                      // The native repair mints its run id; the others reuse run.id.
                      id:
                        path === "native-repair" ? expect.any(String) : run.id,
                      status: path === "native-repair" ? "queued" : "running",
                      kind:
                        path === "native-repair" ? "native-extraction" : "ocr",
                      requestSource:
                        path === "native-repair" ? "repair" : "manual",
                      claimedBy: {
                        projection: claimToken,
                        dispatch: expect.any(String),
                        "native-repair": null,
                      }[path],
                      attemptCount: path === "dispatch" ? 1 : 0,
                    },
                  ]);
                  if (path === "native-repair") {
                    // `result` is the wrapper's open generic; compare it as data.
                    const repairedIds: unknown = result;
                    expect(repairedIds).toEqual(rows.map(({ id }) => id));
                  }
                  if (path === "dispatch") {
                    expect(result).toEqual(
                      expect.objectContaining(
                        rows.at(0) ?? panic("Dispatched run missing"),
                      ),
                    );
                  }
                  if (path === "projection") {
                    expect(
                      await tx
                        .select({
                          ocrRunId: extractedContent.ocrRunId,
                          sourceFieldId: extractedContent.sourceFieldId,
                          charCount: extractedContent.charCount,
                        })
                        .from(extractedContent)
                        .where(eq(extractedContent.entityId, source.entityId)),
                    ).toEqual([
                      {
                        ocrRunId: run.id,
                        sourceFieldId: source.fieldId,
                        charCount: 4,
                      },
                    ]);
                  }
                }
                if (path === "dispatch") {
                  if (first === "deletion") {
                    expect(result).toBeNull();
                  }
                  // The real claim has completed its writes; stop before the
                  // processing stage starts heartbeats or reads source bytes.
                  return null;
                }
                return result;
              }),
          });
          const runWriter = async () => {
            await runQueueWriter({
              path,
              first,
              database,
              fixture,
              run,
              claimToken,
            });
          };
          const runDeletion = async () => {
            await deletion.db.transaction(async (tx) => {
              if (first === "deletion") {
                if (parent === "organization") {
                  await tx
                    .select({ id: organization.id })
                    .from(organization)
                    .where(eq(organization.id, organizationId))
                    .for("update");
                } else {
                  await tx
                    .select({ id: workspaces.id })
                    .from(workspaces)
                    .where(eq(workspaces.id, workspaceId))
                    .for("update");
                }
                ready.resolve(undefined);
                await release.promise;
              }
              if (parent === "organization") {
                await tx
                  .delete(organization)
                  .where(eq(organization.id, organizationId));
              } else {
                await tx
                  .delete(workspaces)
                  .where(eq(workspaces.id, workspaceId));
              }
            });
          };
          pending.push(first === "deletion" ? runDeletion() : runWriter());
          await withTimeout(async () => await ready.promise, {
            label: "Queue source/deletion transaction barrier",
            timeoutMs: 3000,
          });
          pending.push(first === "deletion" ? runWriter() : runDeletion());
          await waitForBlockedPid(observer.sql, {
            waitingPid: first === "deletion" ? ocrPid : deletionPid,
            holdingPid: first === "deletion" ? deletionPid : ocrPid,
          });
          release.resolve(undefined);
          const outcomes = await Promise.allSettled(pending);
          expect(outcomes.map(({ status }) => status)).toEqual([
            "fulfilled",
            "fulfilled",
          ]);
          await Promise.all(pending);
          expect(
            await setup.db
              .select({ id: entities.id })
              .from(entities)
              .where(eq(entities.workspaceId, workspaceId)),
          ).toEqual([]);
          expect(
            await setup.db
              .select({ id: documentProcessingRuns.id })
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.workspaceId, workspaceId)),
          ).toEqual([]);
          expect(
            await setup.db
              .select({ id: extractedContent.entityId })
              .from(extractedContent)
              .where(eq(extractedContent.workspaceId, workspaceId)),
          ).toEqual([]);
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
    },
    15_000,
  );
}
