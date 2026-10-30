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
import {
  DOCUMENT_OCR_PROCESSOR_VERSION,
  DOCUMENT_PROCESSING_MAX_ATTEMPTS,
} from "@/api/lib/document-processing-contract";
import {
  createDocumentProcessingReconciliationPhases,
  markRunFailed,
  persistMissingNativeExtractionRuns,
  persistOcrProjection,
  processDocumentProcessingRun,
} from "@/api/lib/document-processing-queue";
import {
  DocumentProcessingJobError,
  SEARCH_INDEX_FAILURE_CODE,
} from "@/api/lib/document-processing-queue-policy";
import { persistManualOcrRun } from "@/api/lib/document-processing-request";
import { restoreManualOcrRunAfterProjectionLoss } from "@/api/lib/search/document-processing-manual-ocr-restore";
import { upsertSearchDocument } from "@/api/lib/search/index-entity";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

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

// Replay commits with triggers enabled before the manual transaction acquires
// parent locks. Supply its earlier identity snapshot only to the unlocked read;
// the real claim lock must read the updated budget from Postgres.
const withRunReadSnapshot = (
  tx: Transaction,
  snapshot: (typeof documentProcessingRuns.$inferSelect)[],
) => {
  let supplied = false;
  const wrap = <T extends object>(target: T, readsRun = false): T =>
    new Proxy(target, {
      get: (object, key) => {
        const member: unknown = Reflect.get(object, key);
        if (typeof member !== "function") {
          return member;
        }
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(member, object, args);
          const isRun =
            readsRun ||
            (key === "from" && args.at(0) === documentProcessingRuns);
          if (key === "limit" && isRun && !supplied) {
            supplied = true;
            return (async () => {
              await result;
              return snapshot;
            })();
          }
          if (
            ["select", "from", "where"].includes(String(key)) &&
            typeof result === "object" &&
            result !== null
          ) {
            return wrap(result, isRun);
          }
          return result;
        };
      },
    });
  return wrap(tx);
};

const searchReplayPhase = (
  db: GatedTestDb,
  indexEntity: Parameters<
    typeof createDocumentProcessingReconciliationPhases
  >[0]["indexEntity"],
) =>
  createDocumentProcessingReconciliationPhases({
    database: asTestRaw<typeof rootDb>(db),
    broadcastWorkspaceResourceUpdated: () => undefined,
    enqueueDocumentDeadlineScout: async () => undefined,
    enqueueDocumentProcessingRun: async () => undefined,
    indexEntity,
    now: () => Date.now(),
    readRepairScanCursor: async () => null,
    readyRepairCursor: async () => undefined,
    repairPassMemo: {
      completedAt: () => null,
      recordCompleted: () => undefined,
    },
    writeRepairScanCursor: async () => true,
  }).find(({ name }) => name === "reindex") ??
  panic("Search replay phase missing");

const seedFailedSearchReplay = async (
  db: GatedTestDb,
  fixture: Awaited<ReturnType<typeof seedOcrFixture>>,
  attemptCount: number,
) => {
  const { organizationId, workspaceId, userId, source } = fixture;
  const id = createSafeId<"documentProcessingRun">();
  await db.insert(documentProcessingRuns).values({
    id,
    organizationId,
    workspaceId,
    ...source,
    kind: "ocr",
    processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
    requestSource: "manual",
    requestedBy: userId,
    status: "failed",
    errorCode: "search_index_failed",
    attemptCount,
    nextAttemptAt: null,
  });
  await db.insert(extractedContent).values({
    entityId: source.entityId,
    organizationId,
    workspaceId,
    ciphertext: Buffer.from("text"),
    iv: Buffer.alloc(12),
    charCount: 4,
  });
  return id;
};

const queuePaths = ["projection", "dispatch", "native-repair"] as const;
type QueuePath = (typeof queuePaths)[number];
const capWriterPaths = [
  "request",
  "restore",
  "automatic",
  ...queuePaths,
] as const;
const capRunStatuses = {
  request: "queued",
  restore: "failed",
  automatic: "queued",
  projection: "running",
  dispatch: "queued",
  "native-repair": "queued",
} as const satisfies Record<
  (typeof capWriterPaths)[number],
  (typeof documentProcessingRuns.$inferSelect)["status"]
>;

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
      panic("Unknown queue writer");
  }
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("OCR workspace serialization against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("pre-schedule search failures recover and exhaust the bounded replay budget", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const fixture = await seedOcrFixture(db);
      let calls = 0;
      const phase = searchReplayPhase(db, async (entityId) => {
        if (entityId === fixture.source.entityId) {
          calls += 1;
        }
        throw new Error("index unavailable");
      });
      try {
        const id = await seedFailedSearchReplay(db, fixture, 0);
        for (
          let count = 1;
          count <= DOCUMENT_PROCESSING_MAX_ATTEMPTS;
          count += 1
        ) {
          await phase.run();
          const row = (
            await db
              .select()
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.id, id))
          ).at(0);
          expect(row?.attemptCount).toBe(count);
          expect(row?.status).toBe("failed");
          expect(calls).toBe(count);
          if (count === DOCUMENT_PROCESSING_MAX_ATTEMPTS) {
            expect(row?.nextAttemptAt).toBeNull();
          } else {
            expect(row?.nextAttemptAt).not.toBeNull();
            await db
              .update(documentProcessingRuns)
              .set({ nextAttemptAt: new Date(Date.now() - 1000) })
              .where(eq(documentProcessingRuns.id, id));
          }
        }
        await phase.run();
        expect(calls).toBe(DOCUMENT_PROCESSING_MAX_ATTEMPTS);
      } finally {
        await fixture.cleanup();
      }
    });
  }, 15_000);

  test.each(
    (["request", "restore"] as const).flatMap((path) =>
      [1, DOCUMENT_PROCESSING_MAX_ATTEMPTS - 1].map((attemptCount) => ({
        path,
        attemptCount,
      })),
    ),
  )(
    "$path observes the locked replay budget starting at $attemptCount",
    async ({ path, attemptCount }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const manual = openClient({ connection: { statement_timeout: 5000 } });
        const replay = openClient({
          max: 1,
          connection: { statement_timeout: 5000 },
        });
        const fixture = await seedOcrFixture(replay.db);
        const { organizationId, workspaceId, userId, source } = fixture;
        try {
          const id = await seedFailedSearchReplay(
            replay.db,
            fixture,
            attemptCount,
          );
          // Use a scheduled row here so the stale-read guard also reaches the
          // old replay predicate independently of the null-schedule regression.
          await replay.db
            .update(documentProcessingRuns)
            .set({ nextAttemptAt: new Date(Date.now() - 1000) })
            .where(eq(documentProcessingRuns.id, id));
          const snapshot = await replay.db
            .select()
            .from(documentProcessingRuns)
            .where(eq(documentProcessingRuns.id, id));
          expect(snapshot.at(0)?.attemptCount).toBe(attemptCount);
          await searchReplayPhase(replay.db, async () => {
            throw new Error("index unavailable");
          }).run();
          const before = (
            await replay.db
              .select()
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.id, id))
          ).at(0);
          expect(before?.attemptCount).toBe(attemptCount + 1);
          expect(before?.status).toBe("failed");
          const db = {
            transaction: async <T>(run: (tx: Transaction) => Promise<T>) =>
              await manual.db.transaction(
                async (tx) => await run(withRunReadSnapshot(tx, snapshot)),
              ),
          };
          await (path === "request"
            ? persistManualOcrRun({
                db,
                organizationId,
                workspaceId,
                userId,
                source,
                recordAuditEvent: async () => undefined,
              })
            : restoreManualOcrRunAfterProjectionLoss({
                db,
                organizationId,
                workspaceId,
                ...source,
              }));
          const after = (
            await replay.db
              .select()
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.id, id))
          ).at(0);
          expect(after?.attemptCount).toBe(
            path === "request" ? 0 : attemptCount + 1,
          );
          expect(after?.status).toBe(
            path === "restore" &&
              attemptCount + 1 === DOCUMENT_PROCESSING_MAX_ATTEMPTS
              ? "failed"
              : "queued",
          );
        } finally {
          await fixture.cleanup();
        }
      });
    },
    15_000,
  );

  test.each(capWriterPaths)(
    "%s completes after the cap writer updates workspace then entity",
    async (path) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const writer = openClient({ connection: { statement_timeout: 5000 } });
        const cap = openClient({ connection: { statement_timeout: 5000 } });
        const observer = openClient();
        const fixture = await seedOcrFixture(setup.db);
        const { organizationId, workspaceId, userId, source } = fixture;
        const ready = Promise.withResolvers<undefined>();
        const continueCap = Promise.withResolvers<undefined>();
        const pending: Promise<unknown>[] = [];
        const claimToken = Bun.randomUUIDv7();
        try {
          await setup.db.insert(organizationSettings).values({
            organizationId,
            documentProcessingMode: "searchable-text",
          });
          const run =
            (
              await setup.db
                .insert(documentProcessingRuns)
                .values({
                  id: createSafeId<"documentProcessingRun">(),
                  organizationId,
                  workspaceId,
                  ...source,
                  kind: "ocr",
                  processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
                  requestSource: "manual",
                  requestedBy: userId,
                  status: capRunStatuses[path],
                  claimedBy: path === "projection" ? claimToken : null,
                  errorCode: path === "restore" ? "search_index_failed" : null,
                })
                .returning()
            ).at(0) ?? panic("Cap serialization fixture missing");
          if (
            path === "request" ||
            path === "automatic" ||
            path === "native-repair"
          ) {
            await setup.db
              .delete(documentProcessingRuns)
              .where(eq(documentProcessingRuns.id, run.id));
          }
          const writerPid =
            (
              await writer.sql<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`
            ).at(0)?.pid ?? panic("Writer session missing");
          const capPid =
            (
              await cap.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
            ).at(0)?.pid ?? panic("Cap session missing");
          pending.push(
            cap.db.transaction(async (tx) => {
              if (path === "automatic" || path === "native-repair") {
                // These chains retain the parent KEY SHARE fence.
                await tx
                  .select({ id: workspaces.id })
                  .from(workspaces)
                  .where(eq(workspaces.id, workspaceId))
                  .for("update");
              } else {
                // A non-key UPDATE is compatible with the old parent KEY SHARE,
                // so the old source-first acquisition reaches the opposing wait.
                await tx
                  .update(workspaces)
                  .set({ name: "Cap matter writer" })
                  .where(eq(workspaces.id, workspaceId));
              }
              ready.resolve(undefined);
              await continueCap.promise;
              await tx
                .update(entities)
                .set({ name: "Cap writer completed" })
                .where(eq(entities.id, source.entityId));
            }),
          );
          await withTimeout(async () => await ready.promise, {
            label: "Cap workspace barrier",
            timeoutMs: 3000,
          });
          const database = asTestRaw<typeof rootDb>({
            transaction: async <T>(
              operation: (tx: Transaction) => Promise<T>,
            ) =>
              await writer.db.transaction(async (tx) => {
                const result = await operation(tx);
                // Dispatch claim writes are the tested transaction; stop before I/O.
                return path === "dispatch" ? null : result;
              }),
          });
          const runWriter = async () => {
            switch (path) {
              case "request":
                expect(
                  (
                    await persistManualOcrRun({
                      db: database,
                      organizationId,
                      workspaceId,
                      userId,
                      source,
                      recordAuditEvent: async () => undefined,
                    })
                  )?.status,
                ).toBe("queued");
                return;
              case "restore":
                await restoreManualOcrRunAfterProjectionLoss({
                  db: database,
                  organizationId,
                  workspaceId,
                  ...source,
                });
                return;
              case "automatic":
                await requestAutomaticDocumentOcr({
                  db: database,
                  organizationId,
                  workspaceId,
                  ...source,
                  requestSource: "upload",
                });
                return;
              case "projection":
              case "dispatch":
              case "native-repair":
                await runQueueWriter({
                  path,
                  first: "ocr",
                  database,
                  fixture,
                  run,
                  claimToken,
                });
                return;
              default:
                path satisfies never;
            }
          };
          pending.push(runWriter());
          await waitForBlockedPid(observer.sql, {
            waitingPid: writerPid,
            holdingPid: capPid,
          });
          continueCap.resolve(undefined);
          await Promise.all(pending);
          expect(
            (
              await setup.db
                .select({ name: entities.name })
                .from(entities)
                .where(eq(entities.id, source.entityId))
            ).at(0)?.name,
          ).toBe("Cap writer completed");
          if (path === "projection") {
            expect(
              (
                await setup.db
                  .select({ ocrRunId: extractedContent.ocrRunId })
                  .from(extractedContent)
                  .where(eq(extractedContent.entityId, source.entityId))
              ).at(0)?.ocrRunId,
            ).toBe(run.id);
          }
          expect(
            (
              await setup.db
                .select({ status: documentProcessingRuns.status })
                .from(documentProcessingRuns)
                .where(eq(documentProcessingRuns.entityId, source.entityId))
            ).at(0)?.status,
          ).toBe(
            path === "projection" || path === "dispatch" ? "running" : "queued",
          );
        } finally {
          continueCap.resolve(undefined);
          await Promise.allSettled(pending);
          await fixture.cleanup();
        }
      });
    },
    15_000,
  );

  test.each([
    { errorCode: SEARCH_INDEX_FAILURE_CODE, retryScheduled: true },
    { errorCode: "processing_failed", retryScheduled: false },
  ] as const)(
    "failure settlement observes the locked claim for $errorCode",
    async ({ errorCode, retryScheduled }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const setup = openClient();
        const holder = openClient({ connection: { statement_timeout: 5000 } });
        const settler = openClient({ connection: { statement_timeout: 5000 } });
        const observer = openClient();
        const fixture = await seedOcrFixture(setup.db);
        const ready = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const pending: Promise<unknown>[] = [];
        const claimToken = Bun.randomUUIDv7();
        try {
          const run =
            (
              await setup.db
                .insert(documentProcessingRuns)
                .values({
                  id: createSafeId<"documentProcessingRun">(),
                  organizationId: fixture.organizationId,
                  workspaceId: fixture.workspaceId,
                  ...fixture.source,
                  kind: "ocr",
                  processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
                  requestSource: "upload",
                  requestedBy: fixture.userId,
                  status: "running",
                  claimedBy: claimToken,
                  attemptCount: 1,
                })
                .returning()
            ).at(0) ?? panic("Claim fixture missing");
          const holderPid =
            (
              await holder.sql<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`
            ).at(0)?.pid ?? panic("Claim holder missing");
          const settlerPid =
            (
              await settler.sql<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`
            ).at(0)?.pid ?? panic("Claim settler missing");
          pending.push(
            holder.db.transaction(async (tx) => {
              await tx
                .select({ id: documentProcessingRuns.id })
                .from(documentProcessingRuns)
                .where(eq(documentProcessingRuns.id, run.id))
                .for("update");
              ready.resolve(undefined);
              await release.promise;
              await tx
                .update(documentProcessingRuns)
                .set({ attemptCount: 2, requestSource: "manual" })
                .where(eq(documentProcessingRuns.id, run.id));
            }),
          );
          await withTimeout(async () => await ready.promise, {
            label: "Claim holder barrier",
            timeoutMs: 3000,
          });
          pending.push(
            markRunFailed({
              database: asTestRaw<typeof rootDb>(settler.db),
              run,
              claimToken,
              error: new DocumentProcessingJobError({
                code: errorCode,
                message: "Search index unavailable",
              }),
            }).then((outcome) => expect(outcome).toBe("settled")),
          );
          await waitForBlockedPid(observer.sql, {
            waitingPid: settlerPid,
            holdingPid: holderPid,
          });
          release.resolve(undefined);
          await Promise.all(pending);
          const settled = (
            await setup.db
              .select({
                status: documentProcessingRuns.status,
                attemptCount: documentProcessingRuns.attemptCount,
                claimedBy: documentProcessingRuns.claimedBy,
                errorCode: documentProcessingRuns.errorCode,
                nextAttemptAt: documentProcessingRuns.nextAttemptAt,
              })
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.id, run.id))
          ).at(0);
          expect(settled).toEqual({
            status: "failed",
            attemptCount: 2,
            claimedBy: null,
            errorCode,
            nextAttemptAt: retryScheduled ? expect.any(Date) : null,
          });
        } finally {
          release.resolve(undefined);
          await Promise.allSettled(pending);
          await fixture.cleanup();
        }
      });
    },
    15_000,
  );

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
              await ocr.db.transaction(
                async (tx) =>
                  await run(
                    first === "ocr"
                      ? withSourceBarrier(tx, {
                          ready: () => firstReady.resolve(undefined),
                          release: releaseFirst.promise,
                        })
                      : tx,
                  ),
              ),
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
