import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";
import type { PermissionInput } from "@stll/permissions";

import { member as organizationMembers } from "@/api/db/auth-schema";
import type { rootDb, Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  entities,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { type OrgAIConfig, resolveCaching } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import {
  hasCurrentActiveWorkspaceMemberPermission,
  requireCurrentActiveWorkspaceMemberPermission,
} from "@/api/lib/db/member-authority";
import {
  isCurrentDeadlineSource,
  loadCurrentDeadlineSourceReader,
} from "@/api/lib/document-content-provenance";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { createModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import {
  createRootMembershipScopedDb,
  createRootSafeDb,
  createRootScopedDb,
} from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  DEADLINE_SCOUT_LEASE_TIMEOUT_MS,
  deadlineScoutDue,
} from "@/api/lib/scouts/document-deadline-skip";
import {
  capText,
  DEADLINE_SYSTEM_PROMPT,
  DEADLINE_TEXT_MIN_CHARS,
  deadlineDedupeKey,
  deadlineExtractionSchema,
  type DeadlineScanAdmission,
  deadlineScanAdmission,
  deadlineScoutFailureStatus,
  deadlineSeverity,
  filterDeadlines,
} from "@/api/lib/scouts/document-deadlines.logic";
import type { NewSignal } from "@/api/lib/signals/emit";
import { runScout } from "@/api/lib/signals/scout";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import type { ManagedModelTier } from "@/api/lib/usage/managed-model-tier";

const DEADLINE_GENERATION_TIMEOUT_MS = 60_000;
// Ten bounded excerpts plus reasoning share the provider's output ceiling.
// A 2,000-token allowance truncated valid extractions before JSON could close.
const DEADLINE_MAX_OUTPUT_TOKENS = 8192;
const DEADLINE_SCOUT_PERMISSIONS = {
  workspace: ["read"],
} as const satisfies PermissionInput;
const DEADLINE_SCOUT_ERROR_CODE = {
  NO_ACTOR: "no_actor",
  OBSERVATION_FAILED: "observation_failed",
  SOURCE_SUPERSEDED: "source_superseded",
} as const;

class DocumentDeadlineScoutError extends TaggedError(
  "DocumentDeadlineScoutError",
)<{
  code: string;
  message: string;
  cause: unknown;
}> {}

type DeadlineScoutDb = Pick<typeof rootDb, "select" | "update">;

export type RunDocumentDeadlineScoutArgs = {
  db: DeadlineScoutDb;
  sourceRunId: SafeId<"documentProcessingRun">;
  /** The RLS database the run's member scopes open; the application's when omitted. */
  database?: RlsDatabase<Transaction>;
  /** The scan's action admission; `withActionAdmission` when omitted. */
  admit?: typeof withActionAdmission;
};

type ClaimedRun = typeof documentProcessingRuns.$inferSelect;
type DeadlineScoutActor = {
  inputDb: ReturnType<typeof createRootMembershipScopedDb>;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  writeDb: ReturnType<typeof createRootScopedDb>;
  writeSafeDb: ReturnType<typeof createRootSafeDb>;
};

type DeadlineScoutClaim = Pick<ClaimedRun, "id" | "deadlineScoutClaimedAt">;

const claimStartedAt = (run: DeadlineScoutClaim): Date =>
  run.deadlineScoutClaimedAt ?? panic("Claimed deadline scout has no lease");

const currentClaimWhere = (run: DeadlineScoutClaim, now: Date) =>
  and(
    eq(documentProcessingRuns.id, run.id),
    eq(documentProcessingRuns.deadlineScoutStatus, "running"),
    sql`${documentProcessingRuns.deadlineScoutClaimedAt} IS NOT DISTINCT FROM ${claimStartedAt(run)}::timestamptz`,
    sql`${documentProcessingRuns.deadlineScoutClaimedAt} > ${now}::timestamptz - (${DEADLINE_SCOUT_LEASE_TIMEOUT_MS} * INTERVAL '1 millisecond')`,
  ) ?? panic("Expected the deadline scout claim predicate");

/** Refresh only the exact live claim; an expired or recovered worker stops. */
const heartbeatClaim = async (
  db: DeadlineScoutDb,
  run: ClaimedRun,
): Promise<boolean> => {
  const now = new Date();
  // audit: skip — ephemeral worker-lease bookkeeping; settlement records the durable outcome.
  const refreshed = await db
    .update(documentProcessingRuns)
    .set({ deadlineScoutClaimedAt: now, updatedAt: now })
    .where(currentClaimWhere(run, now))
    .returning({ claimedAt: documentProcessingRuns.deadlineScoutClaimedAt });
  const claimedAt = refreshed.at(0)?.claimedAt;
  if (claimedAt === undefined || claimedAt === null) {
    return false;
  }
  run.deadlineScoutClaimedAt = claimedAt;
  return true;
};

/** Lock claim authority through signal emission in the caller's transaction. */
const lockCurrentClaim = async (
  tx: Transaction,
  run: ClaimedRun,
): Promise<boolean> => {
  const locked = await withAggregateRowQuery({
    tx,
    aggregate: "processingClaim",
    id: { id: run.id, workspaceId: run.workspaceId },
    mode: "update",
    select: (queryTx) =>
      queryTx
        .select({
          id: documentProcessingRuns.id,
          workspaceId: documentProcessingRuns.workspaceId,
        })
        .from(documentProcessingRuns),
    where: currentClaimWhere(run, new Date()),
  });
  return locked.rows.length === 1;
};

const hasDeadlineScoutAuthority = async (
  actor: DeadlineScoutActor,
  db: Transaction,
): Promise<boolean> =>
  await hasCurrentActiveWorkspaceMemberPermission({
    db,
    organizationId: actor.organizationId,
    userId: actor.userId,
    workspaceId: actor.workspaceId,
    permissions: DEADLINE_SCOUT_PERMISSIONS,
  });

const requireDeadlineScoutAuthority = async (
  actor: DeadlineScoutActor,
  db: Transaction,
): Promise<void> => {
  await requireCurrentActiveWorkspaceMemberPermission({
    db,
    organizationId: actor.organizationId,
    userId: actor.userId,
    workspaceId: actor.workspaceId,
    permissions: DEADLINE_SCOUT_PERMISSIONS,
  });
};

const loadAuthorizedSource = async (
  actor: DeadlineScoutActor,
  run: ClaimedRun,
) => {
  const source = await actor.inputDb(async (tx) => {
    await requireDeadlineScoutAuthority(actor, tx);
    return await loadCurrentDeadlineSourceReader(tx, "deadline-scout", run);
  });
  return source
    ? { entityName: source.entityName, text: await source.readText() }
    : null;
};

const loadAuthorizedAISettings = async (actor: DeadlineScoutActor) =>
  await actor.inputDb(async (tx) => {
    await requireDeadlineScoutAuthority(actor, tx);
    return await loadOrgAISettings(tx, actor);
  });

const createDeadlineScoutActor = (
  run: ClaimedRun,
  userId: SafeId<"user">,
  database: RlsDatabase<Transaction> | undefined,
): DeadlineScoutActor => {
  const member = { organizationId: run.organizationId, userId };
  const pinned = { ...member, workspaceIds: [run.workspaceId] };
  return {
    ...member,
    workspaceId: run.workspaceId,
    inputDb: createRootMembershipScopedDb(member, database),
    writeDb: createRootScopedDb(pinned, database),
    writeSafeDb: createRootSafeDb(pinned, database),
  };
};

const admittedDeadlineScan = (): { admission: DeadlineScanAdmission } => ({
  admission: { type: "admitted" },
});

const claimRun = async (
  db: DeadlineScoutDb,
  sourceRunId: SafeId<"documentProcessingRun">,
): Promise<ClaimedRun | null> => {
  const now = new Date();
  const claimed = await db
    .update(documentProcessingRuns)
    .set({
      deadlineScoutAttemptCount: sql`${documentProcessingRuns.deadlineScoutAttemptCount} + 1`,
      deadlineScoutClaimedAt: now,
      deadlineScoutErrorCode: null,
      deadlineScoutSkippedUntil: null,
      deadlineScoutStatus: "running",
      updatedAt: now,
    })
    .where(
      and(
        eq(documentProcessingRuns.id, sourceRunId),
        eq(documentProcessingRuns.status, "succeeded"),
        eq(documentProcessingRuns.deadlineScoutStatus, "pending"),
        deadlineScoutDue(now),
      ),
    )
    .returning();
  return claimed.at(0) ?? null;
};

const resolveActorUserId = async (
  db: DeadlineScoutDb,
  run: ClaimedRun,
): Promise<SafeId<"user"> | null> => {
  const candidates = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, run.organizationId),
        eq(organizationMembers.userId, workspaceMembers.userId),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, workspaceMembers.workspaceId),
        eq(workspaces.organizationId, run.organizationId),
      ),
    )
    .innerJoin(
      entities,
      and(
        eq(entities.id, run.entityId),
        eq(entities.workspaceId, workspaces.id),
      ),
    )
    .where(eq(workspaceMembers.workspaceId, run.workspaceId))
    .orderBy(
      sql`CASE
        WHEN ${workspaceMembers.userId} = ${run.requestedBy} THEN 0
        WHEN ${workspaceMembers.userId} = ${entities.createdBy} THEN 1
        WHEN ${workspaceMembers.userId} = ${workspaces.leadUserId} THEN 2
        ELSE 3
      END`,
      asc(workspaceMembers.createdAt),
      asc(workspaceMembers.id),
    )
    .limit(1);
  const actor = candidates.at(0);
  return actor ? brandPersistedUserId(actor.userId) : null;
};

type ExtractDeadlinesOptions = {
  /** Built once admission has fixed the managed model tier the scan runs on. */
  createAnalytics: (
    modelTier: ManagedModelTier,
  ) => ReturnType<typeof createTanStackAIAnalyticsCallbacks>;
  managedAIResidency: ManagedAIResidency;
  orgAIConfig: OrgAIConfig | null;
  prompt: string;
  run: ClaimedRun;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  onRefused: (admission: DeadlineScanAdmission) => void;
  admit: typeof withActionAdmission | undefined;
};

/**
 * One scan draws one action of the member it runs as. A scan refused for an
 * exhausted period is skipped until the period ends; any other refusal fails
 * its observation and retries like any other failure.
 */
const extractDeadlines = async ({
  createAnalytics,
  managedAIResidency,
  orgAIConfig,
  prompt,
  run,
  scopedDb,
  userId,
  onRefused,
  admit,
}: ExtractDeadlinesOptions) => {
  const admitted = await createModelActionAdmitter({
    organizationId: run.organizationId,
    userId,
    organizationStateDb: scopedDb,
    actionKind: "documents.scan-deadlines",
    ...(admit === undefined ? {} : { admit }),
  })(
    async ({ admission }) =>
      await generateTanStackObjectForTask({
        userId: admission.userId,
        dataClass: "customer",
        task: "chat",
        organizationId: run.organizationId,
        admission,
        tenantWorkspaceIds: [run.workspaceId],
        orgAIConfig,
        managedAIResidency,
        analytics: createAnalytics(admission.modelTier),
        system: DEADLINE_SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: DEADLINE_MAX_OUTPUT_TOKENS,
        caching: resolveCaching({
          promptCachingEnabled: false,
          task: "chat",
          scopeKey: run.organizationId,
        }),
        serviceTier: "flex",
        deadlineMs: DEADLINE_GENERATION_TIMEOUT_MS,
        outputSchema: deadlineExtractionSchema,
      }),
  );
  if (Result.isError(admitted)) {
    const { error } = admitted;
    onRefused(deadlineScanAdmission(error));
    // An observation reports its failure by rejecting, as the model call
    // itself does; a refused scan is such a failure.
    throw error;
  }
  return admitted.value;
};

/**
 * How a claimed scan settles. `skipped`: an exhausted action period refused
 * it; it returns to `pending` until `skippedUntil`, and the refused claim
 * does not use one of its attempts.
 */
type DeadlineScanSettlement =
  | {
      status: "pending" | "succeeded" | "failed" | "cancelled";
      errorCode: string | null;
    }
  | { status: "skipped"; skippedUntil: Date };

const settledColumns = (settlement: DeadlineScanSettlement) => {
  switch (settlement.status) {
    case "skipped":
      return {
        attemptRefund: 1,
        errorCode: ACTION_ADMISSION_CODES.periodExhausted,
        skippedUntil: settlement.skippedUntil,
        status: "pending",
      } as const;
    case "pending":
    case "succeeded":
    case "failed":
    case "cancelled":
      return {
        attemptRefund: 0,
        errorCode: settlement.errorCode,
        skippedUntil: null,
        status: settlement.status,
      };
    default:
      settlement satisfies never;
      return panic("Unhandled deadline scan settlement");
  }
};

const settleRun = async ({
  db,
  run,
  settlement,
}: {
  db: Pick<DeadlineScoutDb, "update">;
  run: DeadlineScoutClaim;
  settlement: DeadlineScanSettlement;
}): Promise<void> => {
  const { attemptRefund, errorCode, skippedUntil, status } =
    settledColumns(settlement);
  await db
    .update(documentProcessingRuns)
    .set({
      deadlineScoutAttemptCount: sql`GREATEST(${documentProcessingRuns.deadlineScoutAttemptCount} - ${attemptRefund}, 0)`,
      deadlineScoutClaimedAt: null,
      deadlineScoutErrorCode: errorCode,
      deadlineScoutSkippedUntil: skippedUntil,
      deadlineScoutStatus: status,
      updatedAt: new Date(),
    })
    .where(currentClaimWhere(run, new Date()));
};

type RejectDeadlineObservationOptions = {
  db: DeadlineScoutDb;
  run: ClaimedRun;
  error: unknown;
};

const rejectDeadlineObservation = async ({
  db,
  run,
  error,
}: RejectDeadlineObservationOptions): Promise<never> => {
  await settleRun({
    db,
    run,
    settlement: {
      errorCode: DEADLINE_SCOUT_ERROR_CODE.OBSERVATION_FAILED,
      status: deadlineScoutFailureStatus(run.deadlineScoutAttemptCount, error),
    },
  });
  throw new DocumentDeadlineScoutError({
    code: DEADLINE_SCOUT_ERROR_CODE.OBSERVATION_FAILED,
    message: "Document deadline observation failed",
    cause: error,
  });
};

type SkipDeadlineScanOptions = {
  db: Pick<DeadlineScoutDb, "update">;
  claimedAt: Date;
  runId: ClaimedRun["id"];
  skippedUntil: Date;
};

/** Settle a running scan that an exhausted action period refused. */
export const skipDeadlineScan = async ({
  claimedAt,
  db,
  runId,
  skippedUntil,
}: SkipDeadlineScanOptions): Promise<void> => {
  await settleRun({
    db,
    run: { id: runId, deadlineScoutClaimedAt: claimedAt },
    settlement: { status: "skipped", skippedUntil },
  });
};

type SettleFailedObservationOptions = RejectDeadlineObservationOptions & {
  admission: DeadlineScanAdmission;
};

const settleFailedObservation = async ({
  db,
  run,
  admission,
  error,
}: SettleFailedObservationOptions): Promise<void> => {
  switch (admission.type) {
    case "period_exhausted":
      await skipDeadlineScan({
        claimedAt: claimStartedAt(run),
        db,
        runId: run.id,
        skippedUntil: admission.skippedUntil,
      });
      return;
    case "admitted":
      return await rejectDeadlineObservation({ db, run, error });
    default:
      admission satisfies never;
      return panic("Unhandled deadline scan admission");
  }
};

/**
 * Read one immutable processing result and surface explicit dated obligations.
 * PostgreSQL owns claiming and retry state; a BullMQ job is only a wake-up.
 */
export const runDocumentDeadlineScout = async ({
  db,
  sourceRunId,
  database,
  admit,
}: RunDocumentDeadlineScoutArgs): Promise<void> => {
  const run = await claimRun(db, sourceRunId);
  if (!run) {
    return;
  }

  const actorUserId = await resolveActorUserId(db, run);
  if (!actorUserId) {
    await settleRun({
      db,
      run,
      settlement: {
        errorCode: DEADLINE_SCOUT_ERROR_CODE.NO_ACTOR,
        status: "failed",
      },
    });
    return;
  }

  const actor = createDeadlineScoutActor(run, actorUserId, database);
  const scan = admittedDeadlineScan();
  const observed = Result.flatten(
    await Result.tryPromise(async () => {
      const orgAIConfigResult = await loadAuthorizedAISettings(actor);
      if (Result.isError(orgAIConfigResult)) {
        return Result.err(orgAIConfigResult.error);
      }
      const { orgAIConfig, managedAIResidency } = orgAIConfigResult.value;
      return Result.ok(
        await runScout({
          db: actor.writeDb,
          organizationId: run.organizationId,
          scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
          observe: async () => {
            const source = await loadAuthorizedSource(actor, run);
            if (!source) {
              return [];
            }
            const text = capText(source.text);
            if (text.length < DEADLINE_TEXT_MIN_CHARS) {
              return [];
            }
            if (!(await heartbeatClaim(db, run))) {
              return [];
            }
            if (
              !(await actor.inputDb(
                async (tx) => await hasDeadlineScoutAuthority(actor, tx),
              ))
            ) {
              return [];
            }

            const extraction = await extractDeadlines({
              createAnalytics: (modelTier) =>
                createTanStackAIAnalyticsCallbacks({
                  dataClass: "customer",
                  feature: "inbox.deadline-scout",
                  modelTask: "chat",
                  orgAIConfig,
                  modelTier,
                  properties: {
                    organization_id: run.organizationId,
                    workspace_id: run.workspaceId,
                  },
                  traceId: Bun.randomUUIDv7(),
                  usageMetering: {
                    actionType: "background",
                    organizationId: run.organizationId,
                    safeDb: actor.writeSafeDb,
                    serviceTier: "flex",
                    userId: actorUserId,
                    workspaceId: run.workspaceId,
                  },
                }),
              managedAIResidency,
              orgAIConfig,
              prompt: `Document "${source.entityName}":\n\n${text}`,
              run,
              scopedDb: actor.writeDb,
              userId: actorUserId,
              onRefused: (admission) => {
                scan.admission = admission;
              },
              admit,
            });

            const now = new Date();
            const kept = filterDeadlines(extraction.deadlines, text, now);
            const sourceIdentity = [
              run.entityVersionId,
              run.fieldId,
              run.sourceFileId,
              run.sourceSha256Hex,
            ].join(":");
            return kept.map((deadline): NewSignal => {
              const dueAt = `${deadline.dueDate}T00:00:00.000Z`;
              return {
                kind: SIGNAL_KIND.DEADLINE_DETECTED,
                scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
                workspaceId: run.workspaceId,
                severity: deadlineSeverity(deadline.dueDate, now),
                confidence: deadline.confidence,
                title: `${deadline.label} due ${deadline.dueDate}`,
                summary: `${source.entityName}: "${deadline.quote}"`,
                subject: {
                  type: "entity",
                  workspaceId: run.workspaceId,
                  entityId: run.entityId,
                },
                evidence: {
                  kind: SIGNAL_KIND.DEADLINE_DETECTED,
                  dueAt,
                  label: deadline.label,
                  quote: deadline.quote,
                  entityId: run.entityId,
                  entityName: source.entityName,
                },
                suggestions: [
                  {
                    kind: SUGGESTION_KIND.CREATE_DEADLINE,
                    workspaceId: run.workspaceId,
                    name: deadline.label,
                    dueAt,
                  },
                  {
                    kind: SUGGESTION_KIND.OPEN_CHAT,
                    prompt: `What does "${source.entityName}" require by ${deadline.dueDate} regarding: ${deadline.label}?`,
                  },
                ],
                dedupeKey: deadlineDedupeKey(
                  sourceIdentity,
                  deadline.dueDate,
                  deadline.quote,
                ),
              };
            });
          },
          validate: async (tx) => {
            if (!(await lockCurrentClaim(tx, run))) {
              return false;
            }
            if (!(await hasDeadlineScoutAuthority(actor, tx))) {
              return false;
            }
            return await isCurrentDeadlineSource(tx, run);
          },
        }),
      );
    }),
  );

  if (Result.isError(observed)) {
    await settleFailedObservation({
      db,
      run,
      admission: scan.admission,
      error: observed.error,
    });
    return;
  }

  await settleRun({
    db,
    run,
    settlement: observed.value.observationAccepted
      ? { errorCode: null, status: "succeeded" }
      : {
          errorCode: DEADLINE_SCOUT_ERROR_CODE.SOURCE_SUPERSEDED,
          status: "cancelled",
        },
  });
};
