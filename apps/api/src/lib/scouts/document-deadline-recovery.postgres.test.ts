import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, getTableColumns, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { rootDb, Transaction } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  entityVersions,
  featureEnrolments,
  fields,
  properties,
  pendingScoutEmissions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
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
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { waitForBlockedPid } from "@/api/tests/helpers/flow-review-gate";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  DEADLINE_DISPATCH_RECOVERY,
  pauseDocumentDeadlineScoutAfterGrantLoss,
  recoverDocumentDeadlineScoutDispatches,
  resumeDocumentDeadlineScoutsAfterGrant,
} from "./document-deadline-recovery";
import {
  runDocumentDeadlineScout,
  validateDocumentDeadlineScoutClaim,
} from "./document-deadlines";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const testState = createTestState({ file: import.meta.path, config: env });

const databaseUrl = process.env["DATABASE_URL"];
const OLD = new Date("2020-01-01T00:00:00Z");

const fixture = async (db: GatedTestDb) =>
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
    const sources = Array.from({ length: 101 }, (_, index) => ({
      runId: createSafeId<"documentProcessingRun">(),
      entityId: createSafeId<"entity">(),
      entityVersionId: createSafeId<"entityVersion">(),
      fieldId: createSafeId<"field">(),
      sourceFileId: createSafeId<"userFile">(),
      workspaceId: index < 100 ? pausedWorkspaceId : admittedWorkspaceId,
      propertyId: index < 100 ? pausedPropertyId : admittedPropertyId,
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
            await client.db.insert(pendingScoutEmissions).values({
              organizationId: f.organizationId,
              workspaceId: f.admittedWorkspaceId,
              sourceKind: "document-review",
              sourceId,
              status: "awaiting_grant",
              nextAttemptAt: OLD,
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
            return panic("Missing claim projection");
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
                  ...getTableColumns(documentProcessingRuns),
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
              .set({ deadlineScoutSkippedUntil: skippedUntil })
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
                    skippedUntil:
                      documentProcessingRuns.deadlineScoutSkippedUntil,
                  })
                  .from(documentProcessingRuns)
                  .where(eq(documentProcessingRuns.id, source.runId))
                  .limit(1)
              ).at(0);
            expect(await read()).toEqual({
              status: "awaiting_grant",
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
            expect(await read()).toEqual({ status: "pending", skippedUntil });
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
