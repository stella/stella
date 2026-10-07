import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";

import { member as organizationMembers } from "@/api/db/auth-schema";
import type { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  entities,
  extractedContent,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { resolveCaching, type OrgAIConfig } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { decryptContent } from "@/api/lib/content-encryption";
import { createModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
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
};

type ClaimedRun = typeof documentProcessingRuns.$inferSelect;

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
  analytics: ReturnType<typeof createTanStackAIAnalyticsCallbacks>;
  managedAIResidency: ManagedAIResidency;
  orgAIConfig: OrgAIConfig | null;
  prompt: string;
  run: ClaimedRun;
  scopedDb: ScopedDb;
  userId: SafeId<"user">;
  onRefused: (admission: DeadlineScanAdmission) => void;
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
    onRefused(deadlineScanAdmission(error));
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

const settleRun = async ({
  db,
  run,
  settlement,
}: {
  db: Pick<DeadlineScoutDb, "update">;
  run: Pick<ClaimedRun, "id">;
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
    .where(
      and(
        eq(documentProcessingRuns.id, run.id),
        eq(documentProcessingRuns.deadlineScoutStatus, "running"),
      ),
    );
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
  runId: ClaimedRun["id"];
  skippedUntil: Date;
};

/** Settle a running scan that an exhausted action period refused. */
export const skipDeadlineScan = async ({
  db,
  runId,
  skippedUntil,
}: SkipDeadlineScanOptions): Promise<void> => {
  await settleRun({
    db,
    run: { id: runId },
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

  const scan: { admission: DeadlineScanAdmission } = {
    admission: { type: "admitted" },
  };
  // The config is read before the scout run opens: an organization barred
  // from the instance provider without a key of its own cannot observe.
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
                  eq(
                    workspaces.organizationId,
                    extractedContent.organizationId,
                  ),
                ),
              )
              .where(currentSourceWhere(run))
              .limit(1);
            return current.length === 1;
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
