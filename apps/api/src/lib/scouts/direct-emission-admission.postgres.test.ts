import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SIGNAL_SEVERITY,
} from "@stll/api-contract/signals";
import { withTimeout } from "@stll/concurrency/with-timeout";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  documentReviewFindings,
  documentReviewRuns,
  entities,
  featureEnrolments,
  pendingScoutEmissions,
  scoutRuns,
  signals,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import type { DocumentReviewRunBasis } from "@/api/lib/document-review/run-contract";
import { finalizeReviewRun } from "@/api/lib/document-review/run-finalize";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { clearMemberAssignments } from "@/api/lib/member-assignment-offboarding-owner";
import { settleDocumentDeadlineScoutClaim } from "@/api/lib/scouts/document-deadlines";
import type { NewSignal } from "@/api/lib/signals/emit";
import { runScout } from "@/api/lib/signals/scout";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  emitDocumentReviewSignal,
  maybeEmitDocumentReviewSignal,
} from "./document-review";
import { emitInfoSoudHearingSignals } from "./infosoud-hearings";
import type { HearingRecord } from "./infosoud-hearings.logic";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const NOW = new Date("2030-01-01T12:00:00.000Z");
const CLAIM = new Date("2030-01-01T12:05:00.000Z");
const BASIS = {
  playbook: {
    definitionId: null,
    versionId: null,
    provenance: "ephemeral",
    definitionSnapshot: {
      name: "Replay playbook",
      positions: { version: 3, items: [] },
    },
  },
  references: [],
  perspective: { type: "neutral" },
} satisfies DocumentReviewRunBasis;
const HEARING = {
  externalId: "hearing-fixture",
  caseMark: "1 C 1/2030",
  court: "Fixture court",
  hearingType: "hearing",
  startAt: NOW,
  cancelled: false,
  date: "2030-01-01",
  time: "12:00",
} satisfies HearingRecord;

const fixtureFor = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const entityId = createSafeId<"entity">();
  const fileFieldId = createSafeId<"field">();
  const entityVersionId = createSafeId<"entityVersion">();
  const runId = createSafeId<"documentReviewRun">();
  const positionId = Bun.randomUUIDv7();
  await db.insert(organization).values({
    id: organizationId,
    name: "Direct emission fixture",
    slug: organizationId,
    createdAt: NOW,
  });
  await db.insert(user).values({
    id: userId,
    name: "Scout actor",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: Bun.randomUUIDv7(),
    organizationId,
    userId,
    role: "member",
    createdAt: NOW,
  });
  await db
    .insert(featureEnrolments)
    .values({ organizationId, userId, featureId: "signals" });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Scout matter",
    reference: workspaceId,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId });
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    name: "review.pdf",
    createdBy: userId,
  });
  await db.insert(documentReviewRuns).values({
    id: runId,
    organizationId,
    workspaceId,
    entityId,
    fileFieldId,
    entityVersionId,
    contentSha256: "a".repeat(64),
    basis: BASIS,
    requestedBy: userId,
    executor: "table",
    status: "running",
    total: 1,
  });
  await db.insert(documentReviewFindings).values({
    id: createSafeId<"documentReviewFinding">(),
    organizationId,
    workspaceId,
    runId,
    entityId,
    fileFieldId,
    entityVersionId,
    positionId,
    positionTitle: "Missing notice",
    outcome: "missing",
    payload: {
      finding: {
        positionId,
        issue: "Missing notice",
        severity: "high",
        standardSource: "tiers",
        verdict: "missing",
        delta: { kind: "language" },
        extracted: null,
        rationale: "Required notice is absent.",
        citations: [],
        fix: null,
      },
    },
  });
  return {
    organizationId,
    userId,
    workspaceId,
    entityId,
    fileFieldId,
    entityVersionId,
    runId,
  };
};

type Fixture = Awaited<ReturnType<typeof fixtureFor>>;
const cleanup = async (db: GatedTestDb, fixture: Fixture) => {
  await db
    .delete(organization)
    .where(eq(organization.id, fixture.organizationId));
  await db.delete(user).where(eq(user.id, fixture.userId));
};

const regrant = async (db: GatedTestDb, fixture: Fixture) =>
  await db.transaction(async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId: fixture.organizationId,
      featureId: "signals",
    });
    await tx.insert(featureEnrolments).values({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      featureId: "signals",
    });
  });

const proposedFor = ({ workspaceId, entityId }: Fixture) =>
  ({
    kind: SIGNAL_KIND.HEARING_CHANGED,
    scoutKey: SCOUT_KEY.INFOSOUD_HEARINGS,
    workspaceId,
    severity: SIGNAL_SEVERITY.NOTICE,
    confidence: null,
    title: "Hearing fixture",
    summary: "Hearing listed",
    subject: { type: "entity", workspaceId, entityId },
    evidence: {
      kind: SIGNAL_KIND.HEARING_CHANGED,
      courtName: HEARING.court,
      caseNumber: HEARING.caseMark,
      hearingType: HEARING.hearingType,
      previousAt: null,
      currentAt: NOW.toISOString(),
      sourceUrl: null,
    },
    suggestions: [],
    dedupeKey: `direct:${entityId}`,
  }) satisfies NewSignal;

describe.skipIf(!enabled)(
  "direct scout admission and receipt ownership (postgres)",
  () => {
    for (const source of ["review", "hearing"] as const) {
      test(`${source}: revocation committed at the production admission lock retains a replayable receipt`, async () => {
        const previous = env.FEATURE_SIGNALS;
        const previousScouts = env.FEATURE_INBOX_DOCUMENT_SCOUTS;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        env.FEATURE_SIGNALS = true;
        env.FEATURE_INBOX_DOCUMENT_SCOUTS = true;
        try {
          await withGatedTestClients(
            process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
            async ({ openClient }) => {
              const atLock = Promise.withResolvers<undefined>();
              const locked = Promise.withResolvers<undefined>();
              let readSource = false;
              const reader = openClient({
                logger: {
                  logQuery: (query) => {
                    if (query.includes('from "document_review_runs"')) {
                      readSource = true;
                    }
                    if (query.includes("pg_advisory_xact_lock")) {
                      atLock.resolve(undefined);
                    }
                  },
                },
              });
              const writer = openClient();
              const fixture = await fixtureFor(writer.db);
              try {
                const revocation = writer.db.transaction(async (tx) => {
                  await lockFeatureRecoveryAdmission({
                    tx,
                    organizationId: fixture.organizationId,
                    featureId: "signals",
                  });
                  locked.resolve(undefined);
                  await withTimeout(async () => await atLock.promise, {
                    label: "producer admission lock",
                    timeoutMs: 10_000,
                  });
                  if (source === "review") {
                    expect(readSource).toBe(true);
                  }
                  await tx
                    .delete(featureEnrolments)
                    .where(
                      eq(
                        featureEnrolments.organizationId,
                        fixture.organizationId,
                      ),
                    );
                });
                await locked.promise;
                const production = reader.db.transaction(async (tx) => {
                  const ownerTx = asTestRaw<Transaction>(tx);
                  if (source === "review") {
                    return await finalizeReviewRun({
                      tx: ownerTx,
                      ...fixture,
                      executor: "table",
                      expectedFindingCount: 1,
                    });
                  }
                  await emitInfoSoudHearingSignals({
                    tx: ownerTx,
                    ...fixture,
                    inserted: [
                      { entityId: fixture.entityId, hearing: HEARING },
                    ],
                    now: NOW,
                  });
                  return undefined;
                });
                const [, finalized] = await Promise.all([
                  revocation,
                  production,
                ]);
                if (source === "review") {
                  expect(finalized).toMatchObject({
                    type: "completed",
                    committed: 1,
                    staged: 0,
                  });
                  expect(
                    (
                      await reader.db
                        .select()
                        .from(documentReviewRuns)
                        .where(eq(documentReviewRuns.id, fixture.runId))
                    ).at(0)?.status,
                  ).toBe("completed");
                }
                expect(
                  await reader.db.$count(
                    signals,
                    eq(signals.organizationId, fixture.organizationId),
                  ),
                ).toBe(0);
                const sourceId =
                  source === "review" ? fixture.runId : fixture.entityId;
                const retained = (
                  await reader.db
                    .select()
                    .from(pendingScoutEmissions)
                    .where(eq(pendingScoutEmissions.sourceId, sourceId))
                ).at(0);
                expect(retained).toBeDefined();
                await regrant(writer.db, fixture);
                await writer.db
                  .update(pendingScoutEmissions)
                  .set({ nextAttemptAt: CLAIM })
                  .where(eq(pendingScoutEmissions.sourceId, sourceId));
                if (source === "review") {
                  await reader.db.transaction(
                    async (tx) =>
                      await emitDocumentReviewSignal({
                        tx: asTestRaw<Transaction>(tx),
                        workspaceId: fixture.workspaceId,
                        runId: fixture.runId,
                      }),
                  );
                }
                for (let replay = 0; replay < 2; replay += 1) {
                  // db-await-in-loop: replay the actual producer twice to verify durable deduplication.
                  await reader.db.transaction(async (tx) => {
                    if (source === "review") {
                      await maybeEmitDocumentReviewSignal({
                        tx: asTestRaw<Transaction>(tx),
                        workspaceId: fixture.workspaceId,
                        runId: fixture.runId,
                      });
                    } else {
                      await emitInfoSoudHearingSignals({
                        tx: asTestRaw<Transaction>(tx),
                        ...fixture,
                        inserted: [
                          { entityId: fixture.entityId, hearing: HEARING },
                        ],
                        now: NOW,
                      });
                    }
                  });
                }
                expect(
                  await reader.db.$count(
                    signals,
                    eq(signals.organizationId, fixture.organizationId),
                  ),
                ).toBe(1);
                expect(
                  (
                    await reader.db
                      .select()
                      .from(pendingScoutEmissions)
                      .where(eq(pendingScoutEmissions.sourceId, sourceId))
                  ).at(0)?.nextAttemptAt,
                ).toEqual(CLAIM);
              } finally {
                atLock.resolve(undefined);
                await cleanup(writer.db, fixture);
              }
            },
          );
        } finally {
          env.FEATURE_SIGNALS = previous;
          env.FEATURE_INBOX_DOCUMENT_SCOUTS = previousScouts;
          restore();
        }
      });
    }

    test("revocation after emission commit cannot refund or reopen an accepted deadline claim", async () => {
      const previous = env.FEATURE_SIGNALS;
      const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
      env.FEATURE_SIGNALS = true;
      try {
        await withGatedTestClients(
          process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
          async ({ openClient }) => {
            const reader = openClient();
            const writer = openClient();
            const fixture = await fixtureFor(writer.db);
            const sourceId = createSafeId<"documentProcessingRun">();
            try {
              await writer.db.insert(documentProcessingRuns).values({
                id: sourceId,
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                entityId: fixture.entityId,
                entityVersionId: fixture.entityVersionId,
                fieldId: fixture.fileFieldId,
                sourceFileId: Bun.randomUUIDv7(),
                sourceSha256Hex: "a".repeat(64),
                kind: "ocr",
                requestSource: "upload",
                status: "succeeded",
                deadlineScoutStatus: "running",
                deadlineScoutClaimedAt: CLAIM,
                deadlineScoutAttemptCount: 1,
              });
              const sourceToken =
                (
                  await writer.db
                    .select({
                      token: timestampCasToken(
                        documentProcessingRuns.deadlineScoutClaimedAt,
                      ),
                    })
                    .from(documentProcessingRuns)
                    .where(eq(documentProcessingRuns.id, sourceId))
                ).at(0)?.token ??
                panic("Missing original deadline claim token");
              let commits = 0;
              let observations = 0;
              const scopedDb = asTestRaw<ScopedDb>(
                async (operation: (tx: Transaction) => Promise<unknown>) => {
                  const value = await reader.db.transaction(
                    async (tx) => await operation(asTestRaw<Transaction>(tx)),
                  );
                  commits += 1;
                  if (commits === 2) {
                    await writer.db.transaction(async (tx) => {
                      await lockFeatureRecoveryAdmission({
                        tx,
                        organizationId: fixture.organizationId,
                        featureId: "signals",
                      });
                      await tx
                        .delete(featureEnrolments)
                        .where(
                          eq(
                            featureEnrolments.organizationId,
                            fixture.organizationId,
                          ),
                        );
                    });
                  }
                  return value;
                },
              );
              const result = await runScout({
                db: scopedDb,
                ...fixture,
                scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
                observe: () => {
                  observations += 1;
                  return [proposedFor(fixture)];
                },
                settle: async (tx, admission) => {
                  if (!admission.observationAccepted) {
                    return;
                  }
                  expect(
                    await settleDocumentDeadlineScoutClaim({
                      db: tx,
                      run: {
                        id: sourceId,
                        deadlineScoutClaimedAtToken: sourceToken,
                      },
                      settlement: { status: "succeeded", errorCode: null },
                    }),
                  ).toEqual({ status: "settled" });
                },
              });
              expect(result.outcome).toBe("emitted");
              await regrant(writer.db, fixture);
              expect(
                await settleDocumentDeadlineScoutClaim({
                  db: reader.db,
                  run: {
                    id: sourceId,
                    deadlineScoutClaimedAtToken: sourceToken,
                  },
                  settlement: {
                    status: "awaiting_grant",
                    errorCode: "feature_not_granted",
                  },
                }),
              ).toEqual({ status: "stale_claim" });
              expect(
                (
                  await reader.db
                    .select()
                    .from(documentProcessingRuns)
                    .where(eq(documentProcessingRuns.id, sourceId))
                ).at(0),
              ).toMatchObject({
                deadlineScoutStatus: "succeeded",
                deadlineScoutAttemptCount: 1,
              });
              expect(observations).toBe(1);
              expect(
                await reader.db.$count(
                  signals,
                  eq(signals.organizationId, fixture.organizationId),
                ),
              ).toBe(1);
            } finally {
              await cleanup(writer.db, fixture);
            }
          },
        );
      } finally {
        env.FEATURE_SIGNALS = previous;
        restore();
      }
    });

    test("membership cleanup refuses a held recovery admission lock and preserves membership", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
        async ({ openClient }) => {
          const reader = openClient();
          const writer = openClient();
          const fixture = await fixtureFor(writer.db);
          try {
            await writer.db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: fixture.organizationId,
                featureId: "signals",
              });
              const safeDb = asTestRaw<SafeDb>(
                async (operation: (tx: Transaction) => Promise<unknown>) =>
                  await reader.db.transaction(
                    async (attempt) =>
                      await operation(asTestRaw<Transaction>(attempt)),
                  ),
              );
              const refused = await abortableTx(
                safeDb,
                async (attempt) =>
                  await clearMemberAssignments({
                    tx: attempt,
                    scope: {
                      type: "organization",
                      organizationId: fixture.organizationId,
                    },
                    userId: fixture.userId,
                    actorUserId: fixture.userId,
                  }),
              );
              expect(Result.isError(refused)).toBe(true);
              if (Result.isError(refused)) {
                expect(refused.error).toMatchObject({
                  status: 409,
                  retryable: true,
                });
              }
              expect(
                await reader.db.$count(
                  member,
                  eq(member.organizationId, fixture.organizationId),
                ),
              ).toBe(1);
            });
          } finally {
            await cleanup(writer.db, fixture);
          }
        },
      );
    });

    for (const race of [
      "revoked",
      "success-replaced",
      "failure-replaced",
    ] as const) {
      test(`${race}: scout effect and census settlement respect the live grant and original claim`, async () => {
        const previous = env.FEATURE_SIGNALS;
        const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
        env.FEATURE_SIGNALS = true;
        try {
          await withGatedTestClients(
            process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL"),
            async ({ openClient }) => {
              const reader = openClient();
              const writer = openClient();
              const fixture = await fixtureFor(writer.db);
              const scopedDb = asTestRaw<ScopedDb>(
                async (operation: (tx: Transaction) => Promise<unknown>) =>
                  await reader.db.transaction(
                    async (tx) => await operation(asTestRaw<Transaction>(tx)),
                  ),
              );
              try {
                const result = await runScout({
                  db: scopedDb,
                  ...fixture,
                  scoutKey: SCOUT_KEY.INFOSOUD_HEARINGS,
                  observe: async () => {
                    await writer.db.transaction(async (tx) => {
                      await lockFeatureRecoveryAdmission({
                        tx,
                        organizationId: fixture.organizationId,
                        featureId: "signals",
                      });
                      if (race === "revoked") {
                        await tx
                          .delete(featureEnrolments)
                          .where(
                            eq(
                              featureEnrolments.organizationId,
                              fixture.organizationId,
                            ),
                          );
                      } else {
                        await tx
                          .update(scoutRuns)
                          .set({ startedAt: CLAIM })
                          .where(
                            and(
                              eq(
                                scoutRuns.organizationId,
                                fixture.organizationId,
                              ),
                              eq(
                                scoutRuns.scoutKey,
                                SCOUT_KEY.INFOSOUD_HEARINGS,
                              ),
                            ),
                          );
                      }
                    });
                    if (race === "failure-replaced") {
                      throw new HandlerError({
                        status: 500,
                        message: "Synthetic stale observation failure",
                      });
                    }
                    return [proposedFor(fixture)];
                  },
                });
                expect(result).toMatchObject({
                  emittedCount: 0,
                  observationAccepted: false,
                  outcome: race === "revoked" ? "paused" : "stale",
                });
                expect(
                  await reader.db.$count(
                    signals,
                    eq(signals.organizationId, fixture.organizationId),
                  ),
                ).toBe(0);
                const census = (
                  await reader.db
                    .select()
                    .from(scoutRuns)
                    .where(eq(scoutRuns.organizationId, fixture.organizationId))
                ).at(0);
                if (race !== "revoked") {
                  expect(census).toMatchObject({
                    status: "running",
                    startedAt: CLAIM,
                    error: null,
                  });
                }
              } finally {
                await cleanup(writer.db, fixture);
              }
            },
          );
        } finally {
          env.FEATURE_SIGNALS = previous;
          restore();
        }
      });
    }
  },
);
