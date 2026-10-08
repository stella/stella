import { panic, Result, TaggedError } from "better-result";
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";

import type { rootDb, Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  entities,
  extractedContent,
  workspaces,
} from "@/api/db/schema";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { decryptContent } from "@/api/lib/content-encryption";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  findSignalsBackgroundActor,
  backgroundFeatureActorExists,
  isBackgroundFeatureEnabled,
} from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { logger } from "@/api/lib/observability/logger";
import { createModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import { pauseDocumentDeadlineScoutAfterGrantLoss } from "@/api/lib/scouts/document-deadline-recovery";
import type { DeadlineScoutClaimSettlement } from "@/api/lib/scouts/document-deadline-recovery";
import { deadlineScoutDue } from "@/api/lib/scouts/document-deadline-skip";
import {
  capText,
  DEADLINE_SYSTEM_PROMPT,
  DEADLINE_TEXT_MIN_CHARS,
  deadlineDedupeKey,
  deadlineExtractionSchema,
  deadlineScanAdmission,
  deadlineScoutFailureStatus,
  type DeadlineScanAdmission,
  deadlineSeverity,
  filterDeadlines,
} from "@/api/lib/scouts/document-deadlines.logic";
import type { NewSignal } from "@/api/lib/signals/emit";
import { runScout } from "@/api/lib/signals/scout";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

const DEADLINE_GENERATION_TIMEOUT_MS = 60_000;
// Ten bounded excerpts plus reasoning share the provider's output ceiling.
// A 2,000-token allowance truncated valid extractions before JSON could close.
const DEADLINE_MAX_OUTPUT_TOKENS = 8192;
const DEADLINE_SCOUT_ERROR_CODE = {
  FEATURE_NOT_GRANTED: "feature_not_granted",
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

type DeadlineScoutDb = Pick<typeof rootDb, "select" | "update" | "transaction">;

export type RunDocumentDeadlineScoutArgs = {
  db: DeadlineScoutDb;
  sourceRunId: SafeId<"documentProcessingRun">;
};

type ClaimedRun = typeof documentProcessingRuns.$inferSelect & {
  deadlineScoutClaimedAt: Date;
  deadlineScoutClaimedAtToken: TimestampCasToken;
};

const claimRun = async (
  db: Pick<DeadlineScoutDb, "update">,
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
    .returning({
      ...getTableColumns(documentProcessingRuns),
      deadlineScoutClaimedAtToken: timestampCasToken(
        documentProcessingRuns.deadlineScoutClaimedAt,
      ),
    });
  const run = claimed.at(0);
  if (!run) {
    return null;
  }
  if (
    run.deadlineScoutClaimedAt === null ||
    run.deadlineScoutClaimedAtToken === null
  ) {
    return panic("Claimed deadline scout has no claim token");
  }
  return {
    ...run,
    deadlineScoutClaimedAt: run.deadlineScoutClaimedAt,
    deadlineScoutClaimedAtToken: run.deadlineScoutClaimedAtToken,
  };
};

type ExtractDeadlinesOptions = {
  analytics: ReturnType<typeof createTanStackAIAnalyticsCallbacks>;
  managedAIResidency: ManagedAIResidency;
  orgAIConfig: OrgAIConfig | null;
  prompt: string;
  run: ClaimedRun;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  onRefused: (admission: DeadlineScoutAdmission) => void;
};

/**
 * One scan draws one action of the member it runs as. A scan refused for an
 * exhausted period is skipped until the period ends; any other refusal fails
 * its observation and retries like any other failure.
 */
const extractDeadlines = async ({
  analytics,
  managedAIResidency,
  orgAIConfig,
  prompt,
  run,
  scopedDb,
  userId,
  onRefused,
}: ExtractDeadlinesOptions) => {
  const admitted = await createModelActionAdmitter({
    organizationId: run.organizationId,
    userId,
    organizationStateDb: scopedDb,
    actionKind: "documents.scan-deadlines",
    beforeReserve: async (reservePeriod) => {
      await scopedDb(async (tx) => {
        const decision = await validateDocumentDeadlineScoutClaim({
          tx,
          run,
          actorUserId: userId,
        });
        if (decision !== "current") {
          const code = {
            "not-granted": DEADLINE_SCOUT_ERROR_CODE.FEATURE_NOT_GRANTED,
            stale_claim: "stale_claim",
            superseded: DEADLINE_SCOUT_ERROR_CODE.SOURCE_SUPERSEDED,
          }[decision];
          throw new DocumentDeadlineScoutError({
            code,
            message: "Deadline observation is no longer admitted",
            cause: null,
          });
        }
        await reservePeriod();
      });
    },
  })(
    async ({ admission }) =>
      await generateTanStackObjectForRole({
        dataClass: "customer",
        role: "chat",
        organizationId: run.organizationId,
        admission,
        tenantWorkspaceIds: [run.workspaceId],
        orgAIConfig,
        managedAIResidency,
        analytics,
        system: DEADLINE_SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: DEADLINE_MAX_OUTPUT_TOKENS,
        caching: resolveCaching({
          promptCachingEnabled: false,
          role: "chat",
          scopeKey: run.organizationId,
        }),
        serviceTier: "flex",
        abortSignal: AbortSignal.timeout(DEADLINE_GENERATION_TIMEOUT_MS),
        outputSchema: deadlineExtractionSchema,
      }),
  );
  if (Result.isError(admitted)) {
    const { error } = admitted;
    const refusal = DocumentDeadlineScoutError.is(error) ? error.code : null;
    switch (refusal) {
      case DEADLINE_SCOUT_ERROR_CODE.FEATURE_NOT_GRANTED:
        onRefused({ type: "feature_not_granted" });
        break;
      case "stale_claim":
        onRefused({ type: "stale_claim" });
        break;
      case DEADLINE_SCOUT_ERROR_CODE.SOURCE_SUPERSEDED:
        onRefused({ type: "source_superseded" });
        break;
      default:
        onRefused(deadlineScanAdmission(error));
    }
    // An observation reports its failure by rejecting, as the model call
    // itself does; a refused scan is such a failure.
    throw error;
  }
  return admitted.value;
};

const currentSourceWhere = (run: ClaimedRun) =>
  and(
    eq(extractedContent.entityId, run.entityId),
    eq(extractedContent.organizationId, run.organizationId),
    eq(extractedContent.workspaceId, run.workspaceId),
    eq(extractedContent.sourceEntityVersionId, run.entityVersionId),
    eq(extractedContent.sourceFieldId, run.fieldId),
    eq(extractedContent.sourceFileId, run.sourceFileId),
    eq(extractedContent.sourceSha256Hex, run.sourceSha256Hex),
    run.kind === "ocr"
      ? eq(extractedContent.ocrRunId, run.id)
      : isNull(extractedContent.ocrRunId),
    eq(entities.currentVersionId, run.entityVersionId),
    eq(workspaces.status, "active"),
  );

const loadCurrentSource = async (db: DeadlineScoutDb, run: ClaimedRun) => {
  const rows = await db
    .select({
      ciphertext: extractedContent.ciphertext,
      entityName: entities.name,
      iv: extractedContent.iv,
    })
    .from(extractedContent)
    .innerJoin(
      entities,
      and(
        eq(entities.id, extractedContent.entityId),
        eq(entities.workspaceId, extractedContent.workspaceId),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, extractedContent.workspaceId),
        eq(workspaces.organizationId, extractedContent.organizationId),
      ),
    )
    .where(currentSourceWhere(run))
    .limit(1);
  return rows.at(0) ?? null;
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

export const settleDocumentDeadlineScoutClaim = async ({
  db,
  run,
  settlement,
}: {
  db: Pick<DeadlineScoutDb, "update">;
  run: Pick<ClaimedRun, "id" | "deadlineScoutClaimedAtToken">;
  settlement: DeadlineScanSettlement;
}): Promise<DeadlineScoutClaimSettlement> => {
  const { attemptRefund, errorCode, skippedUntil, status } =
    settledColumns(settlement);
  // audit: skip - original-token settlement records the durable scout outcome and attempt bookkeeping.
  const settled = await db
    .update(documentProcessingRuns)
    .set({
      deadlineScoutAttemptCount: sql`GREATEST(${documentProcessingRuns.deadlineScoutAttemptCount} - ${attemptRefund}, 0)`,
      deadlineScoutClaimedAt: null,
      deadlineScoutErrorCode: errorCode,
      deadlineScoutSkippedUntil: skippedUntil,
      deadlineScoutStatus: status,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, run.id),
        eq(documentProcessingRuns.deadlineScoutStatus, "running"),
        timestampMatchesCasToken(
          documentProcessingRuns.deadlineScoutClaimedAt,
          run.deadlineScoutClaimedAtToken,
        ),
      ),
    )
    .returning({ id: documentProcessingRuns.id });
  return { status: settled.length === 0 ? "stale_claim" : "settled" };
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
}: RejectDeadlineObservationOptions): Promise<void> => {
  const settled = await settleDocumentDeadlineScoutClaim({
    db,
    run,
    settlement: {
      errorCode: DEADLINE_SCOUT_ERROR_CODE.OBSERVATION_FAILED,
      status: deadlineScoutFailureStatus(run.deadlineScoutAttemptCount, error),
    },
  });
  if (settled.status === "stale_claim") {
    return;
  }
  throw new DocumentDeadlineScoutError({
    code: DEADLINE_SCOUT_ERROR_CODE.OBSERVATION_FAILED,
    message: "Document deadline observation failed",
    cause: error,
  });
};

type SkipDeadlineScanOptions = {
  db: DeadlineScoutDb;
  runId: ClaimedRun["id"];
  claimedAtToken: TimestampCasToken;
} & (
  | { reason: "period_exhausted"; skippedUntil: Date }
  | { reason: "feature_not_granted" }
);

/** A refused claim returns its attempt; only period exhaustion delays its retry. */
export const skipDeadlineScan = async ({
  db,
  runId,
  claimedAtToken,
  ...refusal
}: SkipDeadlineScanOptions): Promise<DeadlineScoutClaimSettlement> => {
  if (refusal.reason === "feature_not_granted") {
    return await pauseDocumentDeadlineScoutAfterGrantLoss({
      database: db,
      sourceRunId: runId,
      from: "running",
      claimedAtToken,
    });
  }
  const settlement = {
    status: "skipped",
    skippedUntil: refusal.skippedUntil,
  } as const;
  return await settleDocumentDeadlineScoutClaim({
    db,
    run: { id: runId, deadlineScoutClaimedAtToken: claimedAtToken },
    settlement,
  });
};

const admittedDeadlineScoutActor = async ({
  db,
  sourceRunId,
}: RunDocumentDeadlineScoutArgs) => {
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    logger.info("scout.document_deadlines.skipped", {
      sourceRunId,
      reason: "deployment_disabled",
    });
    return null;
  }
  const sourceRun = (
    await db
      .select()
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, sourceRunId))
      .limit(1)
  ).at(0);
  if (!sourceRun) {
    return null;
  }
  const actorUserId = await findSignalsBackgroundActor({
    tx: db,
    organizationId: sourceRun.organizationId,
    workspaceId: sourceRun.workspaceId,
  });
  if (!actorUserId) {
    await pauseDocumentDeadlineScoutAfterGrantLoss({
      database: db,
      sourceRunId,
      from: "pending",
    });
    logger.info("scout.document_deadlines.skipped", {
      sourceRunId,
      reason: "no_granted_member",
    });
    return null;
  }
  return actorUserId;
};

type ValidateDeadlineSourceOptions = {
  tx: Transaction;
  run: ClaimedRun;
  actorUserId: SafeId<"user">;
};

export const validateDocumentDeadlineScoutClaim = async ({
  tx,
  run,
  actorUserId,
}: ValidateDeadlineSourceOptions) => {
  await lockFeatureRecoveryAdmission({
    tx,
    organizationId: run.organizationId,
    featureId: "signals",
  });
  if (
    !(await isBackgroundFeatureEnabled({
      tx,
      organizationId: run.organizationId,
      userId: actorUserId,
      featureId: "signals",
    }))
  ) {
    return "not-granted" as const;
  }
  const actorMatter = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, run.workspaceId),
        eq(workspaces.organizationId, run.organizationId),
        backgroundFeatureActorExists({
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          userId: actorUserId,
          featureId: "signals",
        }),
      ),
    )
    .limit(1);
  if (actorMatter.length === 0) {
    return "not-granted" as const;
  }
  await tx
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.id, run.entityId),
        eq(entities.workspaceId, run.workspaceId),
      ),
    )
    .for("update");
  const claimed = await tx
    .select({ id: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.id, run.id),
        eq(documentProcessingRuns.deadlineScoutStatus, "running"),
        timestampMatchesCasToken(
          documentProcessingRuns.deadlineScoutClaimedAt,
          run.deadlineScoutClaimedAtToken,
        ),
      ),
    )
    .for("update");
  if (claimed.length === 0) {
    return "stale_claim" as const;
  }
  const current = await tx
    .select({ entityId: extractedContent.entityId })
    .from(extractedContent)
    .innerJoin(
      entities,
      and(
        eq(entities.id, extractedContent.entityId),
        eq(entities.workspaceId, extractedContent.workspaceId),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, extractedContent.workspaceId),
        eq(workspaces.organizationId, extractedContent.organizationId),
      ),
    )
    .where(currentSourceWhere(run))
    .limit(1);
  return current.length === 1 ? ("current" as const) : ("superseded" as const);
};

type PauseDeadlineScoutOptions = {
  db: DeadlineScoutDb;
  run: ClaimedRun;
};

const pauseDeadlineScout = async ({
  db,
  run,
}: PauseDeadlineScoutOptions): Promise<void> => {
  await skipDeadlineScan({
    db,
    runId: run.id,
    claimedAtToken: run.deadlineScoutClaimedAtToken,
    reason: "feature_not_granted",
  });
  logger.info("scout.document_deadlines.skipped", {
    sourceRunId: run.id,
    reason: "actor_not_granted",
  });
};

type DeadlineScoutAdmission =
  | DeadlineScanAdmission
  | { type: "stale_claim" }
  | { type: "feature_not_granted" }
  | { type: "source_superseded" };

type SettleFailedObservationOptions = RejectDeadlineObservationOptions & {
  admission: DeadlineScoutAdmission;
};

const settleFailedObservation = async ({
  db,
  run,
  admission,
  error,
}: SettleFailedObservationOptions): Promise<void> => {
  switch (admission.type) {
    case "source_superseded":
      await settleDocumentDeadlineScoutClaim({
        db,
        run,
        settlement: {
          status: "cancelled",
          errorCode: DEADLINE_SCOUT_ERROR_CODE.SOURCE_SUPERSEDED,
        },
      });
      return;
    case "stale_claim":
      return;
    case "feature_not_granted":
      await pauseDeadlineScout({ db, run });
      return;
    case "period_exhausted":
      await skipDeadlineScan({
        db,
        runId: run.id,
        claimedAtToken: run.deadlineScoutClaimedAtToken,
        reason: "period_exhausted",
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
const settleAcceptedDeadlineObservation = async ({
  tx,
  run,
  scan,
  observationAccepted,
  featureEnabled,
}: {
  tx: Transaction;
  run: ClaimedRun;
  scan: { admission: DeadlineScoutAdmission };
  observationAccepted: boolean;
  featureEnabled: boolean;
}): Promise<boolean> => {
  if (scan.admission.type !== "admitted" || !featureEnabled) {
    return false;
  }
  const settled = await settleDocumentDeadlineScoutClaim({
    db: tx,
    run,
    settlement: observationAccepted
      ? { errorCode: null, status: "succeeded" }
      : {
          errorCode: DEADLINE_SCOUT_ERROR_CODE.SOURCE_SUPERSEDED,
          status: "cancelled",
        },
  });
  if (settled.status === "stale_claim") {
    panic("Deadline claim changed under its emission lock");
  }
  return true;
};

const claimAdmittedDeadlineSource = async ({
  db,
  sourceRunId,
  actorUserId,
}: RunDocumentDeadlineScoutArgs & {
  actorUserId: SafeId<"user">;
}): Promise<ClaimedRun | null> =>
  await db.transaction(async (tx) => {
    const source = (
      await tx
        .select({
          organizationId: documentProcessingRuns.organizationId,
          workspaceId: documentProcessingRuns.workspaceId,
        })
        .from(documentProcessingRuns)
        .where(eq(documentProcessingRuns.id, sourceRunId))
        .limit(1)
    ).at(0);
    if (!source) {
      return null;
    }
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId: source.organizationId,
      featureId: "signals",
    });
    if (
      !(await isBackgroundFeatureEnabled({
        tx,
        organizationId: source.organizationId,
        userId: actorUserId,
        featureId: "signals",
      }))
    ) {
      return null;
    }
    const accessible = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, source.workspaceId),
          backgroundFeatureActorExists({
            organizationId: source.organizationId,
            workspaceId: source.workspaceId,
            userId: actorUserId,
            featureId: "signals",
          }),
        ),
      )
      .limit(1);
    if (accessible.length === 0) {
      return null;
    }
    return await claimRun(tx, sourceRunId);
  });

export const runDocumentDeadlineScout = async ({
  db,
  sourceRunId,
}: RunDocumentDeadlineScoutArgs): Promise<void> => {
  const actorUserId = await admittedDeadlineScoutActor({ db, sourceRunId });
  if (!actorUserId) {
    return;
  }
  const run = await claimAdmittedDeadlineSource({
    db,
    sourceRunId,
    actorUserId,
  });
  if (!run) {
    return;
  }

  const scopedDb = createRootScopedDb({
    organizationId: run.organizationId,
    userId: actorUserId,
    workspaceIds: [run.workspaceId],
  });
  const safeDb = createRootSafeDb({
    organizationId: run.organizationId,
    userId: actorUserId,
    workspaceIds: [run.workspaceId],
  });

  const scan: { admission: DeadlineScoutAdmission } = {
    admission: { type: "admitted" },
  };
  // The config is read before the scout run opens: an organization barred
  // from the instance provider without a key of its own cannot observe.
  let sourceSettled = false;
  const observed = Result.flatten(
    await Result.tryPromise(async () => {
      const orgAIConfigResult = await loadOrgAISettings(db, {
        organizationId: run.organizationId,
        userId: actorUserId,
      });
      if (Result.isError(orgAIConfigResult)) {
        return Result.err(orgAIConfigResult.error);
      }
      const { orgAIConfig, managedAIResidency } = orgAIConfigResult.value;
      return Result.ok(
        await runScout({
          db: scopedDb,
          organizationId: run.organizationId,
          userId: actorUserId,
          scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
          observe: async () => {
            const source = await loadCurrentSource(db, run);
            if (!source) {
              return [];
            }
            const text = capText(
              await decryptContent(
                run.organizationId,
                source.ciphertext,
                source.iv,
              ),
            );
            if (text.length < DEADLINE_TEXT_MIN_CHARS) {
              return [];
            }

            const analytics = createTanStackAIAnalyticsCallbacks({
              dataClass: "customer",
              feature: "inbox.deadline-scout",
              modelRole: "chat",
              orgAIConfig,
              properties: {
                organization_id: run.organizationId,
                workspace_id: run.workspaceId,
              },
              traceId: Bun.randomUUIDv7(),
              usageMetering: {
                actionType: "background",
                organizationId: run.organizationId,
                safeDb,
                serviceTier: "flex",
                userId: actorUserId,
                workspaceId: run.workspaceId,
              },
            });
            const extraction = await extractDeadlines({
              analytics,
              managedAIResidency,
              orgAIConfig,
              prompt: `Document "${source.entityName}":\n\n${text}`,
              run,
              scopedDb,
              userId: actorUserId,
              onRefused: (admission) => {
                scan.admission = admission;
              },
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
            const decision = await validateDocumentDeadlineScoutClaim({
              tx,
              run,
              actorUserId,
            });
            if (decision === "not-granted") {
              scan.admission = { type: "feature_not_granted" };
            }
            if (decision === "stale_claim") {
              scan.admission = { type: "stale_claim" };
            }
            return decision === "current";
          },
          settle: async (tx, admission) => {
            sourceSettled = await settleAcceptedDeadlineObservation({
              tx,
              run,
              scan,
              ...admission,
            });
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

  if (
    sourceSettled ||
    observed.value.outcome === "stale" ||
    scan.admission.type === "stale_claim"
  ) {
    return;
  }
  if (
    observed.value.outcome === "paused" ||
    scan.admission.type === "feature_not_granted"
  ) {
    await pauseDeadlineScout({ db, run });
    return;
  }

  // Accepted observations settled in the signal transaction.
};
