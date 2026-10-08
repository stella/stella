import { Result, TaggedError } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";

import type { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  extractedContent,
  workspaces,
} from "@/api/db/schema";
import { resolveCaching } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  findSignalsBackgroundActor,
  isBackgroundFeatureEnabled,
} from "@/api/lib/feature-access/background";
import { logger } from "@/api/lib/observability/logger";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  capText,
  DEADLINE_SYSTEM_PROMPT,
  DEADLINE_TEXT_MIN_CHARS,
  deadlineDedupeKey,
  deadlineExtractionSchema,
  deadlineScoutFailureStatus,
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
  const claimed = await db
    .update(documentProcessingRuns)
    .set({
      deadlineScoutAttemptCount: sql`${documentProcessingRuns.deadlineScoutAttemptCount} + 1`,
      deadlineScoutClaimedAt: new Date(),
      deadlineScoutErrorCode: null,
      deadlineScoutStatus: "running",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(documentProcessingRuns.id, sourceRunId),
        eq(documentProcessingRuns.status, "succeeded"),
        eq(documentProcessingRuns.deadlineScoutStatus, "pending"),
      ),
    )
    .returning();
  return claimed.at(0) ?? null;
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

const settleRun = async ({
  db,
  errorCode,
  run,
  status,
}: {
  db: DeadlineScoutDb;
  errorCode: string | null;
  run: ClaimedRun;
  status: "pending" | "succeeded" | "failed" | "cancelled";
}): Promise<void> => {
  await db
    .update(documentProcessingRuns)
    .set({
      deadlineScoutClaimedAt: null,
      deadlineScoutErrorCode: errorCode,
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
    errorCode: DEADLINE_SCOUT_ERROR_CODE.OBSERVATION_FAILED,
    run,
    status: deadlineScoutFailureStatus(run.deadlineScoutAttemptCount, error),
  });
  throw new DocumentDeadlineScoutError({
    code: DEADLINE_SCOUT_ERROR_CODE.OBSERVATION_FAILED,
    message: "Document deadline observation failed",
    cause: error,
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
    logger.info("scout.document_deadlines.skipped", {
      sourceRunId,
      reason: "no_granted_member",
    });
    return null;
  }
  return actorUserId;
};

type ValidateDeadlineSourceOptions = {
  tx: Parameters<typeof isBackgroundFeatureEnabled>[0]["tx"];
  run: ClaimedRun;
  actorUserId: SafeId<"user">;
};

const validateDeadlineSource = async ({
  tx,
  run,
  actorUserId,
}: ValidateDeadlineSourceOptions) => {
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
/**
 * Read one immutable processing result and surface explicit dated obligations.
 * PostgreSQL owns claiming and retry state; a BullMQ job is only a wake-up.
 */
export const runDocumentDeadlineScout = async ({
  db,
  sourceRunId,
}: RunDocumentDeadlineScoutArgs): Promise<void> => {
  const actorUserId = await admittedDeadlineScoutActor({ db, sourceRunId });
  if (!actorUserId) {
    return;
  }
  const run = await claimRun(db, sourceRunId);
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

  const observationAdmission = { rejected: false };

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
            const extraction = await generateTanStackObjectForRole({
              dataClass: "customer",
              role: "chat",
              organizationId: run.organizationId,
              tenantWorkspaceIds: [run.workspaceId],
              orgAIConfig,
              managedAIResidency,
              analytics,
              system: DEADLINE_SYSTEM_PROMPT,
              prompt: `Document "${source.entityName}":\n\n${text}`,
              maxOutputTokens: DEADLINE_MAX_OUTPUT_TOKENS,
              caching: resolveCaching({
                promptCachingEnabled: false,
                role: "chat",
                scopeKey: run.organizationId,
              }),
              serviceTier: "flex",
              abortSignal: AbortSignal.timeout(DEADLINE_GENERATION_TIMEOUT_MS),
              outputSchema: deadlineExtractionSchema,
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
            const decision = await validateDeadlineSource({
              tx,
              run,
              actorUserId,
            });
            observationAdmission.rejected = decision === "not-granted";
            return decision === "current";
          },
        }),
      );
    }),
  );

  if (Result.isError(observed)) {
    return await rejectDeadlineObservation({ db, run, error: observed.error });
  }

  if (
    observationAdmission.rejected ||
    !(await isBackgroundFeatureEnabled({
      tx: db,
      organizationId: run.organizationId,
      userId: actorUserId,
      featureId: "signals",
    }))
  ) {
    await settleRun({
      db,
      errorCode: DEADLINE_SCOUT_ERROR_CODE.FEATURE_NOT_GRANTED,
      run,
      status: "pending",
    });
    logger.info("scout.document_deadlines.skipped", {
      sourceRunId,
      reason: "actor_not_granted",
    });
    return;
  }
  await settleRun({
    db,
    errorCode: observed.value.observationAccepted
      ? null
      : DEADLINE_SCOUT_ERROR_CODE.SOURCE_SUPERSEDED,
    run,
    status: observed.value.observationAccepted ? "succeeded" : "cancelled",
  });
};
