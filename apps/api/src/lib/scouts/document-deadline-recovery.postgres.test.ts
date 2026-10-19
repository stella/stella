import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, getColumns, sql } from "drizzle-orm";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  extractedContent,
  featureEnrolments,
  fields,
  properties,
  pendingScoutEmissions,
  signals,
  notifications,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { mutateRecoveryClaim } from "@/api/lib/db/recovery-bookkeeping/claims";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import { DOCUMENT_OCR_PROCESSOR_VERSION } from "@/api/lib/document-processing-contract";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  RECOVER_SCOUT_EMISSION_TASK,
  recoverScoutEmission,
  resumeScoutEmissionAfterGrant,
} from "@/api/lib/scheduler/tasks/scout-emission-recovery";
import type { SchedulerJob } from "@/api/lib/scheduler/types";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withOrgScopedFixture } from "@/api/tests/helpers/org-scoped-fixture";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

import {
  DEADLINE_DISPATCH_RECOVERY,
  pauseDocumentDeadlineScoutAfterGrantLoss,
  recoverDocumentDeadlineScoutDispatches,
  resumeDocumentDeadlineScoutsAfterGrant,
} from "./document-deadline-recovery";
import {
  runDocumentDeadlineScout,
  settleDocumentDeadlineScoutClaim,
  validateDocumentDeadlineScoutClaim,
} from "./document-deadlines";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const testState = createTestState({ file: import.meta.path, config: env });

const databaseUrl = process.env["DATABASE_URL"];
const OLD = new Date("2020-01-01T00:00:00Z");

type DeadlineFixtureOptions = { pausedSources: number };
const fixture = async (db: GatedTestDb, options?: DeadlineFixtureOptions) =>
  await db.transaction(async (tx) => {
    const organizationId = mintAuthProviderId<"organization">();
    const admittedUserId = mintAuthProviderId<"user">();
    const pausedUserId = mintAuthProviderId<"user">();
    const admittedWorkspaceId = createSafeId<"workspace">();
    const pausedWorkspaceId = createSafeId<"workspace">();
    const admittedPropertyId = createSafeId<"property">();
    const pausedPropertyId = createSafeId<"property">();
    await tx.insert(organization).values({
      id: organizationId,
      name: "Deadline recovery",
      slug: organizationId,
      createdAt: OLD,
    });
    await tx.insert(user).values(
      [admittedUserId, pausedUserId].map((id) => ({
        id,
        name: "Scout recipient",
        email: `${id}@example.test`,
        emailVerified: true,
      })),
    );
    await tx.insert(member).values(
      [admittedUserId, pausedUserId].map((userId) => ({
        id: Bun.randomUUIDv7(),
        organizationId,
        userId,
        role: "member",
        createdAt: OLD,
      })),
    );
    await tx.insert(workspaces).values(
      [admittedWorkspaceId, pausedWorkspaceId].map((id) => ({
        id,
        organizationId,
        name: "Private matter",
        reference: id,
      })),
    );
    await tx.insert(workspaceMembers).values([
      { workspaceId: admittedWorkspaceId, userId: admittedUserId },
      { workspaceId: pausedWorkspaceId, userId: pausedUserId },
    ]);
    await tx
      .insert(featureEnrolments)
      .values({ organizationId, userId: admittedUserId, featureId: "signals" });
    await tx.insert(properties).values(
      [
        { id: admittedPropertyId, workspaceId: admittedWorkspaceId },
        { id: pausedPropertyId, workspaceId: pausedWorkspaceId },
      ].map(
        (scope) =>
          ({
            ...scope,
            name: "File",
            status: "fresh",
            content: { version: 1, type: "file" },
            tool: { version: 1, type: "manual-input" },
          }) as const satisfies typeof properties.$inferInsert,
      ),
    );
    const pausedSources = options?.pausedSources ?? 100;
    const sources = Array.from({ length: pausedSources + 1 }, (_, index) => ({
      runId: createSafeId<"documentProcessingRun">(),
      entityId: createSafeId<"entity">(),
      entityVersionId: createSafeId<"entityVersion">(),
      fieldId: createSafeId<"field">(),
      sourceFileId: createSafeId<"userFile">(),
      workspaceId:
        index < pausedSources ? pausedWorkspaceId : admittedWorkspaceId,
      propertyId: index < pausedSources ? pausedPropertyId : admittedPropertyId,
      updatedAt: new Date(OLD.getTime() + index),
    }));
    await tx.insert(entities).values(
      sources.map(
        (source) =>
          ({
            id: source.entityId,
            workspaceId: source.workspaceId,
            kind: "document",
            name: "Deadline document",
          }) as const satisfies typeof entities.$inferInsert,
      ),
    );
    await tx.insert(entityVersions).values(
      sources.map((source) => ({
        id: source.entityVersionId,
        entityId: source.entityId,
        workspaceId: source.workspaceId,
      })),
    );
    await tx.insert(fields).values(
      sources.map(
        (source) =>
          ({
            id: source.fieldId,
            workspaceId: source.workspaceId,
            propertyId: source.propertyId,
            entityVersionId: source.entityVersionId,
            content: {
              version: 1,
              type: "file",
              id: source.sourceFileId,
              fileName: "deadline.pdf",
              mimeType: "application/pdf",
              sizeBytes: 1024,
              encrypted: false,
              sha256Hex: "a".repeat(64),
              pdfFileId: null,
            },
          }) as const satisfies typeof fields.$inferInsert,
      ),
    );
    await tx.insert(documentProcessingRuns).values(
      sources.map(
        (source) =>
          ({
            id: source.runId,
            organizationId,
            workspaceId: source.workspaceId,
            entityId: source.entityId,
            entityVersionId: source.entityVersionId,
            fieldId: source.fieldId,
            sourceFileId: source.sourceFileId,
            sourceSha256Hex: "a".repeat(64),
            kind: "ocr",
            processorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
            requestSource: "upload",
            status: "succeeded",
            finishedAt: OLD,
            deadlineScoutStatus: "pending",
            updatedAt: source.updatedAt,
          }) as const satisfies typeof documentProcessingRuns.$inferInsert,
      ),
    );
    return {
      organizationId,
      admittedUserId,
      admittedWorkspaceId,
      pausedUserId,
      pausedWorkspaceId,
      sources,
    };
  });

describe.skipIf(!enabled)("deadline admission recovery (postgres)", () => {
  test.each(["validation", "settlement"] as const)(
    "%s deadline owner retains other organizations' fresh sources",
    async (entry) => {
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      testState.setConfig("FEATURE_SIGNALS", true);
      try {
        await withGatedTestClients(
          databaseUrl ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const { db } = openClient();
            const a = await fixture(db, { pausedSources: 0 });
            const b = await fixture(db, { pausedSources: 0 });
            const source = a.sources.at(0) ?? panic("Missing admitted source");
            try {
              const claimedAt = new Date();
              await db
                .update(documentProcessingRuns)
                .set({
                  deadlineScoutStatus: "running",
                  deadlineScoutClaimedAt: claimedAt,
                  deadlineScoutAttemptCount: 1,
                })
                .where(
                  eq(documentProcessingRuns.organizationId, a.organizationId),
                );
              await db
                .update(documentProcessingRuns)
                .set({
                  deadlineScoutStatus: "running",
                  deadlineScoutClaimedAt: claimedAt,
                  deadlineScoutAttemptCount: 1,
                })
                .where(
                  eq(documentProcessingRuns.organizationId, b.organizationId),
                );
              await db
                .update(entities)
                .set({ currentVersionId: source.entityVersionId })
                .where(eq(entities.id, source.entityId));
              await db.insert(extractedContent).values({
                entityId: source.entityId,
                organizationId: a.organizationId,
                workspaceId: source.workspaceId,
                sourceEntityVersionId: source.entityVersionId,
                sourceFieldId: source.fieldId,
                sourceFileId: source.sourceFileId,
                sourceSha256Hex: "a".repeat(64),
                ocrRunId: source.runId,
                ocrProcessorVersion: DOCUMENT_OCR_PROCESSOR_VERSION,
                ocrPayloadCiphertext: Buffer.from("fixture"),
                ocrPayloadIv: Buffer.alloc(12),
                ciphertext: Buffer.from("fixture"),
                iv: Buffer.alloc(12),
                charCount: 7,
              });
              const claimed =
                (
                  await db
                    .select({
                      ...getColumns(documentProcessingRuns),
                      deadlineScoutClaimedAtToken: timestampCasToken(
                        documentProcessingRuns.deadlineScoutClaimedAt,
                      ),
                    })
                    .from(documentProcessingRuns)
                    .where(eq(documentProcessingRuns.id, source.runId))
                ).at(0) ?? panic("Missing deadline claim");
              const run = {
                ...claimed,
                deadlineScoutClaimedAt:
                  claimed.deadlineScoutClaimedAt ??
                  panic("Missing deadline claim time"),
                deadlineScoutClaimedAtToken:
                  claimed.deadlineScoutClaimedAtToken ??
                  panic("Missing deadline claim token"),
              };
              const readB = async () => ({
                runs: await db.query.documentProcessingRuns.findMany({
                  where: { organizationId: { eq: b.organizationId } },
                }),
                entities: await db.query.entities.findMany({
                  where: { workspaceId: { eq: b.admittedWorkspaceId } },
                }),
                content: await db.query.extractedContent.findMany({
                  where: { organizationId: { eq: b.organizationId } },
                }),
                signals: await db.query.signals.findMany({
                  where: { organizationId: { eq: b.organizationId } },
                }),
                notices: await db
                  .select()
                  .from(notifications)
                  .where(eq(notifications.organizationId, b.organizationId))
                  .orderBy(notifications.id),
              });
              const before = await readB();
              expect(before.runs.at(0)?.deadlineScoutStatus).toBe("running");
              switch (entry) {
                case "validation":
                  expect(
                    await rootDb.transaction(
                      async (tx) =>
                        await validateDocumentDeadlineScoutClaim({
                          tx,
                          actorUserId: a.admittedUserId,
                          run,
                        }),
                    ),
                  ).toBe("current");
                  break;
                case "settlement":
                  expect(
                    await settleDocumentDeadlineScoutClaim({
                      db: rootDb,
                      run,
                      settlement: { status: "succeeded", errorCode: null },
                    }),
                  ).toEqual({ status: "settled" });
                  expect(
                    (
                      await db.query.documentProcessingRuns.findFirst({
                        where: { id: { eq: source.runId } },
                      })
                    )?.deadlineScoutStatus,
                  ).toBe("succeeded");
                  break;
                default:
                  entry satisfies never;
              }
              expect(await readB()).toEqual(before);
            } finally {
              await db
                .delete(organization)
                .where(eq(organization.id, b.organizationId));
              await db.delete(user).where(eq(user.id, b.admittedUserId));
              await db.delete(user).where(eq(user.id, b.pausedUserId));
              await db
                .delete(organization)
                .where(eq(organization.id, a.organizationId));
              await db.delete(user).where(eq(user.id, a.admittedUserId));
              await db.delete(user).where(eq(user.id, a.pausedUserId));
            }
          },
        );
      } finally {
        restore();
      }
    },
  );

  test.each(["resume", "dispatch", "direct"] as const)(
    "%s deadline owner preserves the other organization's sources",
    async (path) => {
      const previousSignals = env.FEATURE_SIGNALS;
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      testState.setConfig("FEATURE_SIGNALS", true);
      try {
        await withGatedTestClients(
          databaseUrl ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const { db } = openClient();
            const a = await fixture(db, { pausedSources: 1 });
            const b = await fixture(db, { pausedSources: 1 });
            const source = a.sources.at(-1) ?? panic("Missing admitted source");
            try {
              await db.insert(member).values({
                id: Bun.randomUUIDv7(),
                organizationId: b.organizationId,
                userId: a.admittedUserId,
                role: "member",
                createdAt: OLD,
              });
              await db.insert(workspaceMembers).values({
                workspaceId: b.admittedWorkspaceId,
                userId: a.admittedUserId,
              });
              await db.insert(featureEnrolments).values({
                organizationId: b.organizationId,
                userId: a.admittedUserId,
                featureId: "signals",
              });
              await db
                .update(documentProcessingRuns)
                .set({
                  deadlineScoutStatus: "awaiting_grant",
                  deadlineScoutErrorCode: "feature_not_granted",
                })
                .where(
                  eq(documentProcessingRuns.organizationId, a.organizationId),
                );
              await db
                .update(documentProcessingRuns)
                .set({
                  deadlineScoutStatus:
                    path === "resume" ? "awaiting_grant" : "not_requested",
                  deadlineScoutErrorCode:
                    path === "resume" ? "feature_not_granted" : null,
                })
                .where(
                  eq(documentProcessingRuns.organizationId, b.organizationId),
                );
              const read = async (organizationId: typeof a.organizationId) =>
                await db
                  .select()
                  .from(documentProcessingRuns)
                  .where(
                    eq(documentProcessingRuns.organizationId, organizationId),
                  )
                  .orderBy(documentProcessingRuns.id);
              const before = await read(b.organizationId);
              const resume = async (userId: typeof a.admittedUserId) =>
                await db.transaction(async (tx) => {
                  await lockFeatureRecoveryAdmission({
                    tx,
                    organizationId: a.organizationId,
                    featureId: "signals",
                  });
                  await resumeDocumentDeadlineScoutsAfterGrant({
                    tx,
                    organizationId: a.organizationId,
                    userId,
                  });
                });
              const ownBefore = await read(a.organizationId);
              await resume(a.pausedUserId);
              expect(await read(a.organizationId)).toEqual(ownBefore);
              testState.setConfig("FEATURE_SIGNALS", false);
              await resume(a.admittedUserId);
              expect(await read(a.organizationId)).toEqual(ownBefore);
              testState.setConfig("FEATURE_SIGNALS", true);
              await db
                .delete(featureEnrolments)
                .where(
                  and(
                    eq(featureEnrolments.organizationId, a.organizationId),
                    eq(featureEnrolments.userId, a.admittedUserId),
                    eq(featureEnrolments.featureId, "signals"),
                  ),
                );
              await resume(a.admittedUserId);
              expect(await read(a.organizationId)).toEqual(ownBefore);
              await db.insert(featureEnrolments).values({
                organizationId: a.organizationId,
                userId: a.admittedUserId,
                featureId: "signals",
              });
              await resume(a.admittedUserId);
              expect(
                (await read(a.organizationId)).find(
                  ({ id }) => id === source.runId,
                )?.deadlineScoutStatus,
              ).toBe("pending");
              expect(
                (await read(a.organizationId))
                  .filter(({ id }) => id !== source.runId)
                  .map(({ deadlineScoutStatus }) => deadlineScoutStatus),
              ).toEqual(["awaiting_grant"]);
              const enqueued: string[] = [];
              switch (path) {
                case "resume":
                  break;
                case "dispatch":
                  await recoverDocumentDeadlineScoutDispatches({
                    database: asTestRaw<typeof rootDb>(db),
                    enqueueDocumentDeadlineScout: async ({ sourceRunId }) => {
                      enqueued.push(sourceRunId);
                    },
                  });
                  expect(
                    enqueued.filter((id) =>
                      a.sources.some(({ runId }) => runId === id),
                    ),
                  ).toEqual([source.runId]);
                  expect(
                    enqueued.filter((id) =>
                      b.sources.some(({ runId }) => runId === id),
                    ),
                  ).toEqual([]);
                  break;
                case "direct":
                  await runDocumentDeadlineScout({
                    db,
                    sourceRunId: source.runId,
                    database: markRlsDatabase(db),
                  });
                  expect(
                    (await read(a.organizationId)).find(
                      ({ id }) => id === source.runId,
                    )?.deadlineScoutStatus,
                  ).not.toBe("pending");
                  break;
                default:
                  path satisfies never;
              }
              expect(await read(b.organizationId)).toEqual(before);
              expect(
                await db
                  .select()
                  .from(pendingScoutEmissions)
                  .where(
                    eq(pendingScoutEmissions.organizationId, b.organizationId),
                  )
                  .orderBy(pendingScoutEmissions.sourceId),
              ).toEqual([]);
              expect(
                await db
                  .select()
                  .from(signals)
                  .where(eq(signals.organizationId, b.organizationId)),
              ).toEqual([]);
              expect(
                await db
                  .select()
                  .from(notifications)
                  .where(eq(notifications.organizationId, b.organizationId)),
              ).toEqual([]);
            } finally {
              await db
                .delete(organization)
                .where(eq(organization.id, b.organizationId));
              await db
                .delete(organization)
                .where(eq(organization.id, a.organizationId));
              await db.delete(user).where(eq(user.id, b.admittedUserId));
              await db.delete(user).where(eq(user.id, b.pausedUserId));
              await db.delete(user).where(eq(user.id, a.admittedUserId));
              await db.delete(user).where(eq(user.id, a.pausedUserId));
            }
          },
        );
      } finally {
        testState.setConfig("FEATURE_SIGNALS", previousSignals);
        restore();
      }
    },
  );

  test("recipient grant recovery leaves source-less review receipts for periodic repair", async () => {
    const previousSignals = env.FEATURE_SIGNALS;
    const previousReviews = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
    testState.setConfig("FEATURE_SIGNALS", true);
    testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", true);
    try {
      await withGatedTestClients(
        databaseUrl ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const client = openClient();
          const f = await fixture(client.db);
          const sourceId = createSafeId<"documentReviewRun">();
          try {
            await withOrgScopedFixture({
              database: client.db,
              workspaceId: f.admittedWorkspaceId,
              fn: async (fixtureTx) =>
                await fixtureTx.insert(pendingScoutEmissions).values({
                  organizationId: f.organizationId,
                  workspaceId: f.admittedWorkspaceId,
                  sourceKind: "document-review",
                  sourceId,
                  status: "awaiting_grant",
                  nextAttemptAt: OLD,
                }),
            });
            await client.db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: f.organizationId,
                featureId: "signals",
              });
              await resumeScoutEmissionAfterGrant({
                tx,
                organizationId: f.organizationId,
                userId: f.admittedUserId,
              });
            });
            expect(
              (
                await client.db
                  .select({
                    status: pendingScoutEmissions.status,
                    retryAt: pendingScoutEmissions.nextAttemptAt,
                  })
                  .from(pendingScoutEmissions)
                  .where(eq(pendingScoutEmissions.sourceId, sourceId))
              ).at(0),
            ).toEqual({ status: "awaiting_grant", retryAt: OLD });
            const now = new Date();
            const job = {
              id: "signals.scoutRecovery.source-less-test",
              task: RECOVER_SCOUT_EMISSION_TASK,
              description: null,
              schedule: { type: "interval", everyMs: 60_000 },
              payload: null,
              enabled: true,
              pausedBy: null,
              pausedUntil: null,
              pauseReason: null,
              nextRunAt: now,
              lastRunAt: null,
              lastSuccessAt: null,
              lastFailureAt: null,
              lastError: null,
              lockedAt: now,
              lockedUntil: null,
              lockedBy: "recovery-test",
              createdAt: now,
              updatedAt: now,
            } as const satisfies SchedulerJob;
            await recoverScoutEmission({
              db: asTestRaw<typeof rootDb>(client.db),
              dueAt: DueSlot.of(job),
              job,
              payload: null,
              runId: createSafeId<"schedulerJobRun">(),
              scheduleContinuation: () => undefined,
              signal: new AbortController().signal,
              logger,
            });
            expect(
              await client.db
                .select({ sourceId: pendingScoutEmissions.sourceId })
                .from(pendingScoutEmissions)
                .where(eq(pendingScoutEmissions.sourceId, sourceId)),
            ).toEqual([]);
          } finally {
            await client.db
              .delete(organization)
              .where(eq(organization.id, f.organizationId));
            await client.db.delete(user).where(eq(user.id, f.admittedUserId));
            await client.db.delete(user).where(eq(user.id, f.pausedUserId));
          }
        },
      );
    } finally {
      testState.setConfig("FEATURE_SIGNALS", previousSignals);
      testState.setConfig("FEATURE_INBOX_DOCUMENT_SCOUTS", previousReviews);
    }
  });

  test("deadline grant recovery resumes one exact page and preserves the remaining backlog", async () => {
    const previousFlag = env.FEATURE_SIGNALS;
    testState.setConfig("FEATURE_SIGNALS", true);
    try {
      await withGatedTestClients(
        databaseUrl ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const client = openClient();
          const f = await fixture(client.db);
          const skippedUntil = new Date(Date.now() + 60 * 60_000);
          try {
            await client.db.insert(workspaceMembers).values({
              workspaceId: f.pausedWorkspaceId,
              userId: f.admittedUserId,
            });
            await client.db
              .update(documentProcessingRuns)
              .set({
                deadlineScoutStatus: "awaiting_grant",
                deadlineScoutErrorCode: "feature_not_granted",
                deadlineScoutSkippedUntil: skippedUntil,
              })
              .where(
                eq(documentProcessingRuns.organizationId, f.organizationId),
              );
            const original = await client.db
              .select({ id: documentProcessingRuns.id })
              .from(documentProcessingRuns)
              .where(
                eq(documentProcessingRuns.organizationId, f.organizationId),
              )
              .orderBy(documentProcessingRuns.id);
            const resume = async () =>
              await client.db.transaction(async (tx) => {
                await lockFeatureRecoveryAdmission({
                  tx,
                  organizationId: f.organizationId,
                  featureId: "signals",
                });
                await resumeDocumentDeadlineScoutsAfterGrant({
                  tx: asTestRaw<Transaction>(tx),
                  organizationId: f.organizationId,
                  userId: f.admittedUserId,
                });
              });
            const read = async () =>
              await client.db
                .select({
                  id: documentProcessingRuns.id,
                  status: documentProcessingRuns.deadlineScoutStatus,
                  skippedUntil:
                    documentProcessingRuns.deadlineScoutSkippedUntil,
                })
                .from(documentProcessingRuns)
                .where(
                  eq(documentProcessingRuns.organizationId, f.organizationId),
                )
                .orderBy(documentProcessingRuns.id);
            await resume();
            const firstPage = await read();
            expect(
              firstPage
                .filter((row) => row.status === "pending")
                .map((row) => row.id),
            ).toEqual(original.slice(0, 100).map((row) => row.id));
            expect(firstPage.at(100)?.status).toBe("awaiting_grant");
            expect(
              firstPage.every(
                (row) => row.skippedUntil?.getTime() === skippedUntil.getTime(),
              ),
            ).toBe(true);
            await resume();
            const drained = await read();
            expect(drained).toHaveLength(101);
            expect(drained.every((row) => row.status === "pending")).toBe(true);
            await resume();
            expect(await read()).toEqual(drained);
          } finally {
            await client.db
              .delete(organization)
              .where(eq(organization.id, f.organizationId));
            await client.db.delete(user).where(eq(user.id, f.admittedUserId));
            await client.db.delete(user).where(eq(user.id, f.pausedUserId));
          }
        },
      );
    } finally {
      testState.setConfig("FEATURE_SIGNALS", previousFlag);
    }
  });

  test("a competing deadline claim waits for commit and then observes the claimed source", async () => {
    await withGatedTestClients(
      databaseUrl ?? panic("Missing PostgreSQL test URL"),
      async ({ openClient }) => {
        const holder = openClient({ max: 1 });
        const contender = openClient({ max: 1 });
        const observer = openClient({ max: 1 });
        const f = await fixture(holder.db);
        const source = f.sources.at(100) ?? panic("Missing admitted source");
        const claimAt = new Date();
        const claim = async (
          tx: Pick<Transaction, "execute" | "rollback" | "select">,
        ) =>
          await mutateRecoveryClaim({
            type: "deadline-claim",
            tx,
            table: documentProcessingRuns,
            spec: DEADLINE_DISPATCH_RECOVERY,
            sourceRunId: source.runId,
            now: claimAt,
            where: sql`${and(
              eq(documentProcessingRuns.id, source.runId),
              eq(documentProcessingRuns.status, "succeeded"),
              eq(documentProcessingRuns.deadlineScoutStatus, "pending"),
            )}`,
          });
        const sessionPid = async (db: GatedTestDb) => {
          const result = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
          const pid = Number(result.at(0)?.["pid"]);
          if (!Number.isSafeInteger(pid)) {
            return panic("Missing database session identity");
          }
          return pid;
        };
        const holdingPid = await sessionPid(holder.db);
        const waitingPid = await sessionPid(contender.db);
        const ready = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const writer = withAggregateTransaction(holder.db, async (tx) => {
          const claimed = await claim(tx);
          expect(claimed.status).toBe("claimed");
          if (claimed.status !== "claimed") {
            panic("Missing claim projection");
          }
          const row = claimed.run;
          expect(row.id).toBe(source.runId);
          expect(row.entityId).toBe(source.entityId);
          expect(row.deadlineScoutClaimedAt).toEqual(claimAt);
          expect(row.deadlineScoutClaimedAtToken).not.toBeNull();
          expect(row.deadlineScoutAttemptCount).toBe(1);
          ready.resolve(undefined);
          await release.promise;
        });
        let competing: ReturnType<typeof claim> | undefined;
        try {
          await Promise.race([ready.promise, writer]);
          competing = withAggregateTransaction(contender.db, claim);
          await waitForBlockedPid(observer.sql, { waitingPid, holdingPid });
          release.resolve(undefined);
          expect(await competing).toEqual({ status: "stale_claim" });
          await writer;
          const persisted = (
            await holder.db
              .select({
                status: documentProcessingRuns.deadlineScoutStatus,
                attempts: documentProcessingRuns.deadlineScoutAttemptCount,
              })
              .from(documentProcessingRuns)
              .where(eq(documentProcessingRuns.id, source.runId))
          ).at(0);
          expect(persisted).toEqual({ status: "running", attempts: 1 });
        } finally {
          release.resolve(undefined);
          await Promise.allSettled(competing ? [writer, competing] : [writer]);
          await holder.db
            .delete(organization)
            .where(eq(organization.id, f.organizationId));
          await holder.db.delete(user).where(eq(user.id, f.admittedUserId));
          await holder.db.delete(user).where(eq(user.id, f.pausedUserId));
        }
      },
    );
  });

  test("effect validation waits for admission before source locks and rejects a replacement claim", async () => {
    const previousFlag = env.FEATURE_SIGNALS;
    testState.setConfig("FEATURE_SIGNALS", true);
    try {
      await withGatedTestClients(
        databaseUrl ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const holder = openClient({ max: 1 });
          const contender = openClient({ max: 1 });
          const observer = openClient({ max: 1 });
          const f = await fixture(holder.db);
          const source = f.sources.at(100) ?? panic("Missing admitted source");
          const originalClaimedAt = new Date(Date.now() - 60_000);
          const replacementClaimedAt = new Date();
          await holder.db
            .update(documentProcessingRuns)
            .set({
              deadlineScoutStatus: "running",
              deadlineScoutClaimedAt: originalClaimedAt,
              deadlineScoutAttemptCount: 2,
            })
            .where(eq(documentProcessingRuns.id, source.runId));
          const claimed =
            (
              await holder.db
                .select({
                  ...getColumns(documentProcessingRuns),
                  deadlineScoutClaimedAtToken: timestampCasToken(
                    documentProcessingRuns.deadlineScoutClaimedAt,
                  ),
                })
                .from(documentProcessingRuns)
                .where(eq(documentProcessingRuns.id, source.runId))
            ).at(0) ?? panic("Missing original claim");
          await holder.db.insert(featureEnrolments).values({
            organizationId: f.organizationId,
            userId: f.pausedUserId,
            featureId: "signals",
          });
          const claimedAtToken =
            claimed.deadlineScoutClaimedAtToken ??
            panic("Missing original deadline claim token");
          // A live grant elsewhere in this organization cannot authorize this private matter.
          expect(
            await holder.db.transaction(
              async (tx) =>
                await validateDocumentDeadlineScoutClaim({
                  tx: asTestRaw<Transaction>(tx),
                  actorUserId: f.pausedUserId,
                  run: {
                    ...claimed,
                    deadlineScoutClaimedAt:
                      claimed.deadlineScoutClaimedAt ??
                      panic("Missing original deadline claim timestamp"),
                    deadlineScoutClaimedAtToken: claimedAtToken,
                  },
                }),
            ),
          ).toBe("not-granted");
          const sessionPid = async (db: GatedTestDb) => {
            const pid = Number(
              (await db.execute(sql`SELECT pg_backend_pid() AS pid`)).at(0)?.[
                "pid"
              ],
            );
            if (!Number.isSafeInteger(pid)) {
              return panic("Missing database session identity");
            }
            return pid;
          };
          const holdingPid = await sessionPid(holder.db);
          const waitingPid = await sessionPid(contender.db);
          const ready = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          const writer = holder.db.transaction(async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: f.organizationId,
              featureId: "signals",
            });
            await tx
              .update(documentProcessingRuns)
              .set({
                deadlineScoutClaimedAt: replacementClaimedAt,
                deadlineScoutAttemptCount: 3,
              })
              .where(eq(documentProcessingRuns.id, source.runId));
            ready.resolve(undefined);
            await release.promise;
          });
          let validation: Promise<unknown> | undefined;
          try {
            await Promise.race([ready.promise, writer]);
            validation = contender.db.transaction(
              async (tx) =>
                await validateDocumentDeadlineScoutClaim({
                  tx: asTestRaw<Transaction>(tx),
                  actorUserId: f.admittedUserId,
                  run: {
                    ...claimed,
                    deadlineScoutClaimedAt:
                      claimed.deadlineScoutClaimedAt ??
                      panic("Missing original deadline claim timestamp"),
                    deadlineScoutClaimedAtToken: claimedAtToken,
                  },
                }),
            );
            await waitForBlockedPid(observer.sql, { waitingPid, holdingPid });
            const waiting = await observer.db.execute(
              sql`SELECT query FROM pg_stat_activity WHERE pid = ${waitingPid}`,
            );
            expect(waiting.at(0)?.["query"]).toMatch(/pg_advisory_xact_lock/u);
            release.resolve(undefined);
            expect(await validation).toBe("stale_claim");
            await writer;
            expect(
              (
                await holder.db
                  .select({
                    status: documentProcessingRuns.deadlineScoutStatus,
                    claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
                    attempts: documentProcessingRuns.deadlineScoutAttemptCount,
                  })
                  .from(documentProcessingRuns)
                  .where(eq(documentProcessingRuns.id, source.runId))
              ).at(0),
            ).toEqual({
              status: "running",
              claimedAt: replacementClaimedAt,
              attempts: 3,
            });
          } finally {
            release.resolve(undefined);
            await Promise.allSettled(
              validation ? [writer, validation] : [writer],
            );
            await holder.db
              .delete(organization)
              .where(eq(organization.id, f.organizationId));
            await holder.db.delete(user).where(eq(user.id, f.admittedUserId));
            await holder.db.delete(user).where(eq(user.id, f.pausedUserId));
          }
        },
      );
    } finally {
      testState.setConfig("FEATURE_SIGNALS", previousFlag);
    }
  });

  test("grant park and resume preserve an unexpired budget backoff", async () => {
    const previousFlag = env.FEATURE_SIGNALS;
    testState.setConfig("FEATURE_SIGNALS", true);
    try {
      await withGatedTestClients(
        databaseUrl ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const client = openClient();
          const f = await fixture(client.db);
          const source = f.sources.at(0) ?? panic("Missing source fixture");
          const skippedUntil = new Date(Date.now() + 60 * 60_000);
          try {
            await client.db
              .update(documentProcessingRuns)
              .set({
                deadlineScoutSkippedUntil: skippedUntil,
                deadlineScoutErrorCode: ACTION_ADMISSION_CODES.periodExhausted,
              })
              .where(eq(documentProcessingRuns.id, source.runId));
            expect(
              await pauseDocumentDeadlineScoutAfterGrantLoss({
                database: asTestRaw<typeof rootDb>(client.db),
                sourceRunId: source.runId,
                from: "pending",
              }),
            ).toEqual({ status: "settled" });
            const read = async () =>
              (
                await client.db
                  .select({
                    status: documentProcessingRuns.deadlineScoutStatus,
                    errorCode: documentProcessingRuns.deadlineScoutErrorCode,
                    skippedUntil:
                      documentProcessingRuns.deadlineScoutSkippedUntil,
                  })
                  .from(documentProcessingRuns)
                  .where(eq(documentProcessingRuns.id, source.runId))
                  .limit(1)
              ).at(0);
            expect(await read()).toEqual({
              status: "awaiting_grant",
              errorCode: "feature_not_granted",
              skippedUntil,
            });
            await client.db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: f.organizationId,
                featureId: "signals",
              });
              await tx.insert(featureEnrolments).values({
                organizationId: f.organizationId,
                userId: f.pausedUserId,
                featureId: "signals",
              });
              await resumeDocumentDeadlineScoutsAfterGrant({
                tx: asTestRaw<Transaction>(tx),
                organizationId: f.organizationId,
                userId: f.pausedUserId,
              });
            });
            expect(await read()).toEqual({
              status: "pending",
              errorCode: ACTION_ADMISSION_CODES.periodExhausted,
              skippedUntil,
            });
            const dispatched: string[] = [];
            await recoverDocumentDeadlineScoutDispatches({
              database: asTestRaw<typeof rootDb>(client.db),
              enqueueDocumentDeadlineScout: async ({ sourceRunId }) => {
                dispatched.push(sourceRunId);
              },
            });
            expect(dispatched).not.toContain(source.runId);
          } finally {
            await client.db
              .delete(organization)
              .where(eq(organization.id, f.organizationId));
            await client.db.delete(user).where(eq(user.id, f.admittedUserId));
            await client.db.delete(user).where(eq(user.id, f.pausedUserId));
          }
        },
      );
    } finally {
      testState.setConfig("FEATURE_SIGNALS", previousFlag);
    }
  });

  for (const grantDelivery of ["immediate", "postcommit-crash"] as const) {
    test(`a hundred paused sources do not block admitted source 101; ${grantDelivery} regrant resumes`, async () => {
      const previousFlag = env.FEATURE_SIGNALS;
      testState.setConfig("FEATURE_SIGNALS", true);
      try {
        await withGatedTestClients(
          databaseUrl ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const client = openClient();
            const f = await fixture(client.db);
            const database = asTestRaw<typeof rootDb>(client.db);
            const dispatched: string[] = [];
            const sweep = async () =>
              await recoverDocumentDeadlineScoutDispatches({
                database,
                enqueueDocumentDeadlineScout: async ({ sourceRunId }) => {
                  dispatched.push(sourceRunId);
                },
              });
            try {
              await sweep();
              expect(dispatched).toEqual([
                f.sources.at(100)?.runId ?? panic("Missing admitted fixture"),
              ]);
              const paused = await client.db
                .select({
                  status: documentProcessingRuns.deadlineScoutStatus,
                  error: documentProcessingRuns.deadlineScoutErrorCode,
                  claimedAt: documentProcessingRuns.deadlineScoutClaimedAt,
                })
                .from(documentProcessingRuns)
                .where(
                  eq(documentProcessingRuns.workspaceId, f.pausedWorkspaceId),
                );
              expect(paused).toHaveLength(100);
              expect(
                paused.every(
                  (row) =>
                    row.status === "awaiting_grant" &&
                    row.error === "feature_not_granted" &&
                    row.claimedAt === null,
                ),
              ).toBe(true);
              const resumedRunId =
                f.sources.at(0)?.runId ?? panic("Missing resumed fixture");
              // A job queued before revocation reaches the worker independently of the sweep.
              await client.db
                .update(documentProcessingRuns)
                .set({
                  deadlineScoutStatus: "pending",
                  deadlineScoutErrorCode: null,
                })
                .where(eq(documentProcessingRuns.id, resumedRunId));
              await runDocumentDeadlineScout({
                db: database,
                sourceRunId: resumedRunId,
              });
              expect(
                (
                  await client.db
                    .select({
                      status: documentProcessingRuns.deadlineScoutStatus,
                      attempts:
                        documentProcessingRuns.deadlineScoutAttemptCount,
                    })
                    .from(documentProcessingRuns)
                    .where(eq(documentProcessingRuns.id, resumedRunId))
                ).at(0),
              ).toEqual({ status: "awaiting_grant", attempts: 0 });
              await client.db.transaction(async (tx) => {
                await lockFeatureRecoveryAdmission({
                  tx,
                  organizationId: f.organizationId,
                  featureId: "signals",
                });
                await tx.insert(featureEnrolments).values({
                  organizationId: f.organizationId,
                  userId: f.pausedUserId,
                  featureId: "signals",
                });
                if (grantDelivery === "immediate") {
                  await resumeDocumentDeadlineScoutsAfterGrant({
                    tx: asTestRaw<Transaction>(tx),
                    organizationId: f.organizationId,
                    userId: f.pausedUserId,
                  });
                }
              });
              if (grantDelivery === "postcommit-crash") {
                await sweep();
              }
              expect(
                await client.db.$count(
                  documentProcessingRuns,
                  and(
                    eq(documentProcessingRuns.workspaceId, f.pausedWorkspaceId),
                    eq(documentProcessingRuns.deadlineScoutStatus, "pending"),
                  ),
                ),
              ).toBe(100);
              // A stale worker that observed opt-out before this grant cannot park the now-admitted source.
              await pauseDocumentDeadlineScoutAfterGrantLoss({
                database,
                sourceRunId: resumedRunId,
                from: "pending",
              });
              expect(
                (
                  await client.db
                    .select({
                      status: documentProcessingRuns.deadlineScoutStatus,
                    })
                    .from(documentProcessingRuns)
                    .where(eq(documentProcessingRuns.id, resumedRunId))
                ).at(0)?.status,
              ).toBe("pending");
            } finally {
              await client.db
                .delete(organization)
                .where(eq(organization.id, f.organizationId));
              await client.db.delete(user).where(eq(user.id, f.admittedUserId));
              await client.db.delete(user).where(eq(user.id, f.pausedUserId));
            }
          },
        );
      } finally {
        testState.setConfig("FEATURE_SIGNALS", previousFlag);
      }
    });
  }
});
