import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { MATTER_VISIBILITY } from "@stll/api-contract";

import { organization } from "@/api/db/auth-schema";
import type { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  fields,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
  DOCUMENT_OCR_PROCESSOR_VERSION,
} from "@/api/lib/document-processing-contract";
import {
  createDocumentProcessingReconciliationPhases,
  processDocumentProcessingRun,
} from "@/api/lib/document-processing-queue";
import {
  claimDocumentProcessingAttempt,
  DOCUMENT_PROCESSING_MAX_ATTEMPTS,
  documentProcessingRetryDelayMs,
  failDocumentProcessingAttempt,
} from "@/api/lib/document-processing-retry";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const {
  DATABASE_URL: databaseUrl,
  STELLA_RUN_POSTGRES_TESTS: postgresTestGate,
} = process.env;
const runPostgresTests = postgresTestGate === "true";

const seedFixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const entityVersionId = createSafeId<"entityVersion">();
  const fieldId = createSafeId<"field">();
  const propertyId = createSafeId<"property">();
  const sourceFileId = Bun.randomUUIDv7();
  const sourceSha256Hex = "a".repeat(64);
  await db.insert(organization).values({
    id: organizationId,
    name: "Retry fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(workspaces).values({
    visibility: MATTER_VISIBILITY.adminsAndAssigned,
    id: workspaceId,
    organizationId,
    name: "Retry matter",
    reference: "RETRY",
  });
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    name: "Retry document",
    kind: "document",
  });
  await db.insert(entityVersions).values({
    id: entityVersionId,
    entityId,
    workspaceId,
    versionNumber: 1,
  });
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
    insertRun: async (
      run: Partial<typeof documentProcessingRuns.$inferInsert> = {},
    ) => {
      const runId = createSafeId<"documentProcessingRun">();
      await db.insert(documentProcessingRuns).values({
        id: runId,
        organizationId,
        workspaceId,
        entityId,
        entityVersionId,
        fieldId,
        sourceFileId,
        sourceSha256Hex,
        kind: "native-extraction",
        processorVersion: DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
        requestSource: "upload",
        ...run,
      });
      return runId;
    },
  };
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("document retry lifecycle against Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("reconciliation terminalizes exhausted queued manual runs without consuming a fresh budget", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const exhaustedFixture = await seedFixture(db);
      const eligibleFixture = await seedFixture(db);
      const recording = installRecordingLogger();
      const now = new Date();
      try {
        const exhaustedId = await exhaustedFixture.insertRun({
          kind: "ocr",
          processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
          requestSource: "manual",
          status: "queued",
          attemptCount: DOCUMENT_PROCESSING_MAX_ATTEMPTS,
          nextAttemptAt: new Date(now.getTime() + 60_000),
          nextDeliveryAt: new Date(now.getTime() + 60_000),
        });
        const eligibleId = await eligibleFixture.insertRun({
          kind: "ocr",
          processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
          requestSource: "manual",
          status: "queued",
          attemptCount: DOCUMENT_PROCESSING_MAX_ATTEMPTS - 1,
        });
        const retryPhase =
          createDocumentProcessingReconciliationPhases({
            database: asTestRaw<typeof rootDb>(db),
            broadcastWorkspaceResourceUpdated: () => undefined,
            enqueueDocumentDeadlineScout: async () => undefined,
            enqueueDocumentProcessingRun: async () => undefined,
            indexEntity: async () => undefined,
            now: () => now.getTime(),
            readRepairScanCursor: async () => null,
            readyRepairCursor: async () => undefined,
            repairPassMemo: {
              completedAt: () => null,
              recordCompleted: () => undefined,
            },
            writeRepairScanCursor: async () => true,
          }).find((phase) => phase.name === "retry") ??
          panic("Retry reconciliation phase missing");
        await retryPhase.run();
        const exhausted = (
          await db
            .select()
            .from(documentProcessingRuns)
            .where(eq(documentProcessingRuns.id, exhaustedId))
        ).at(0);
        expect(exhausted?.status).toBe("failed");
        expect(exhausted?.finishedAt).toEqual(now);
        expect(exhausted?.errorCode).toBe("worker_lease_expired");
        expect(exhausted?.nextAttemptAt).toBeNull();
        expect(exhausted?.nextDeliveryAt).toBeNull();
        expect(exhausted?.attemptCount).toBe(DOCUMENT_PROCESSING_MAX_ATTEMPTS);
        const eligible = (
          await db
            .select()
            .from(documentProcessingRuns)
            .where(eq(documentProcessingRuns.id, eligibleId))
        ).at(0);
        expect(eligible?.status).toBe("queued");
        expect(eligible?.finishedAt).toBeNull();
        expect(eligible?.attemptCount).toBe(
          DOCUMENT_PROCESSING_MAX_ATTEMPTS - 1,
        );
        await retryPhase.run();
        const exhaustedAfterReplay = (
          await db
            .select()
            .from(documentProcessingRuns)
            .where(eq(documentProcessingRuns.id, exhaustedId))
        ).at(0);
        expect(exhaustedAfterReplay).toEqual(exhausted);
        expect(
          recording
            .at("ERROR")
            .filter(
              (record) =>
                record.message === "document_processing.run_failed" &&
                record.attributes?.["runId"] === exhaustedId,
            ),
        ).toHaveLength(1);
      } finally {
        recording.restore();
        await db
          .delete(organization)
          .where(eq(organization.id, exhaustedFixture.organizationId));
        await db
          .delete(organization)
          .where(eq(organization.id, eligibleFixture.organizationId));
      }
    });
  });

  test.each(["native-extraction", "ocr"] as const)(
    "%s failures back off, exhaust the attempt budget, and leave healthy work claimable",
    async (kind) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await seedFixture(db);
        const healthyFixture = await seedFixture(db);
        const database = asTestRaw<typeof rootDb>(db);
        let now = new Date();
        try {
          const runId = await fixture.insertRun({
            kind,
            processorVersion:
              kind === "ocr"
                ? DOCUMENT_OCR_PROCESSOR_VERSION
                : DOCUMENT_NATIVE_EXTRACTION_PROCESSOR_VERSION,
          });
          const healthyRunId = await healthyFixture.insertRun({
            nextDeliveryAt: new Date(now.getTime() + 60_000),
          });
          const retryPhase =
            createDocumentProcessingReconciliationPhases({
              database,
              broadcastWorkspaceResourceUpdated: () => undefined,
              enqueueDocumentDeadlineScout: async () => undefined,
              enqueueDocumentProcessingRun: async () => undefined,
              indexEntity: async () => undefined,
              now: () => now.getTime(),
              readRepairScanCursor: async () => null,
              readyRepairCursor: async () => undefined,
              repairPassMemo: {
                completedAt: () => null,
                recordCompleted: () => undefined,
              },
              writeRepairScanCursor: async () => true,
            }).find((phase) => phase.name === "retry") ??
            panic("Retry reconciliation phase missing");
          const observedDelays: number[] = [];
          for (
            let attemptCount = 1;
            attemptCount <= DOCUMENT_PROCESSING_MAX_ATTEMPTS;
            attemptCount += 1
          ) {
            const claimToken = Bun.randomUUIDv7();
            const attemptNow = now;
            const claimed = await database.transaction(
              async (tx) =>
                await claimDocumentProcessingAttempt({
                  database: tx,
                  runId,
                  claimToken,
                  now: attemptNow,
                }),
            );
            expect(claimed?.attemptCount).toBe(attemptCount);
            expect(
              await database.transaction(
                async (tx) =>
                  await claimDocumentProcessingAttempt({
                    database: tx,
                    runId,
                    claimToken: "duplicate",
                    now: attemptNow,
                  }),
              ),
            ).toBeNull();
            const errorMessage = `Permanent extraction failure ${attemptCount}`;
            expect(
              await failDocumentProcessingAttempt({
                database,
                runId,
                claimToken,
                errorCode: "processing_failed",
                errorMessage,
                now,
              }),
            ).toEqual({
              attemptCount,
              retryScheduled: attemptCount < DOCUMENT_PROCESSING_MAX_ATTEMPTS,
            });
            const failed = (
              await db
                .select()
                .from(documentProcessingRuns)
                .where(eq(documentProcessingRuns.id, runId))
            ).at(0);
            expect(failed?.status).toBe("failed");
            expect(failed?.errorMessage).toBe(errorMessage);
            if (attemptCount === 1) {
              let healthyExtractions = 0;
              await processDocumentProcessingRun(
                database,
                healthyRunId,
                new AbortController().signal,
                {
                  executeNativeExtraction: async () => {
                    healthyExtractions += 1;
                    return "persisted";
                  },
                },
              );
              const healthy = (
                await db
                  .select()
                  .from(documentProcessingRuns)
                  .where(eq(documentProcessingRuns.id, healthyRunId))
              ).at(0);
              expect(healthyExtractions).toBe(1);
              expect(healthy?.attemptCount).toBe(1);
              expect(healthy?.status).toBe("succeeded");
            }
            if (attemptCount === DOCUMENT_PROCESSING_MAX_ATTEMPTS) {
              expect(failed?.nextAttemptAt).toBeNull();
              expect(failed?.finishedAt).toEqual(now);
              break;
            }
            const delay = documentProcessingRetryDelayMs(attemptCount);
            observedDelays.push(delay);
            expect(failed?.nextAttemptAt).toEqual(
              new Date(now.getTime() + delay),
            );
            expect(failed?.finishedAt).toBeNull();
            now = new Date(now.getTime() + delay - 1);
            await retryPhase.run();
            const earlyNow = now;
            expect(
              await database.transaction(
                async (tx) =>
                  await claimDocumentProcessingAttempt({
                    database: tx,
                    runId,
                    claimToken: "early",
                    now: earlyNow,
                  }),
              ),
            ).toBeNull();
            now = new Date(now.getTime() + 1);
            await retryPhase.run();
          }
          for (const [index, delay] of observedDelays.entries()) {
            if (index > 0) {
              expect(delay).toBeGreaterThan(observedDelays.at(index - 1) ?? 0);
            }
          }
          now = new Date(now.getTime() + 365 * 24 * 60 * 60_000);
          await retryPhase.run();
          expect(
            await database.transaction(
              async (tx) =>
                await claimDocumentProcessingAttempt({
                  database: tx,
                  runId,
                  claimToken: "after-exhaustion",
                  now,
                }),
            ),
          ).toBeNull();
          const terminal = (
            await db
              .select()
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.id, runId))
          ).at(0);
          expect(terminal?.attemptCount).toBe(DOCUMENT_PROCESSING_MAX_ATTEMPTS);
          expect(terminal?.status).toBe("failed");
          expect(terminal?.errorMessage).toBe(
            `Permanent extraction failure ${DOCUMENT_PROCESSING_MAX_ATTEMPTS}`,
          );
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, fixture.organizationId));
          await db
            .delete(organization)
            .where(eq(organization.id, healthyFixture.organizationId));
        }
      });
    },
  );

  const blockedDeliveries = [
    {
      label: "a queued job backing off",
      run: {
        status: "queued",
        attemptCount: 0,
        nextAttemptAt: new Date(Date.now() + 60 * 60_000),
      },
    },
    {
      label: "a terminal failed job",
      run: {
        status: "failed",
        attemptCount: DOCUMENT_PROCESSING_MAX_ATTEMPTS,
        errorCode: "processing_failed",
        errorMessage: "Permanent failure",
        finishedAt: new Date(),
      },
    },
    {
      label: "a queued job with an exhausted attempt budget",
      run: {
        status: "queued",
        attemptCount: DOCUMENT_PROCESSING_MAX_ATTEMPTS,
      },
    },
    {
      label: "a failed job delivered before retry reconciliation",
      run: {
        status: "failed",
        attemptCount: 1,
        nextAttemptAt: new Date(Date.now() - 1000),
        errorCode: "processing_failed",
        errorMessage: "Scheduled retry",
      },
    },
  ] as const satisfies readonly {
    label: string;
    run: Partial<typeof documentProcessingRuns.$inferInsert>;
  }[];

  test.each(blockedDeliveries)(
    "the worker does not start extraction for $label",
    async ({ run }) => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const fixture = await seedFixture(db);
        let extractions = 0;
        try {
          // Each run uses its own live field and exact source fingerprint,
          // so source cancellation cannot conceal an incorrect claim.
          const runId = await fixture.insertRun(run);
          await processDocumentProcessingRun(
            asTestRaw<typeof rootDb>(db),
            runId,
            new AbortController().signal,
            {
              executeNativeExtraction: async () => {
                extractions += 1;
                return "persisted";
              },
            },
          );
          expect(extractions).toBe(0);
          const stored = (
            await db
              .select()
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.id, runId))
          ).at(0);
          expect(stored?.attemptCount).toBe(run.attemptCount);
          expect(stored?.status).toBe(run.status);
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, fixture.organizationId));
        }
      });
    },
  );
}
