import { Result, TaggedError } from "better-result";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";

import { member as organizationMembers } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  documentProcessingRuns,
  entities,
  extractedContent,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { resolveCaching } from "@/api/lib/ai-config";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  capText,
  DEADLINE_SYSTEM_PROMPT,
  DEADLINE_TEXT_MIN_CHARS,
  deadlineDedupeKey,
  deadlineExtractionSchema,
  deadlineSeverity,
  filterDeadlines,
} from "@/api/lib/scouts/document-deadlines.logic";
import type { NewSignal } from "@/api/lib/signals/emit";
import { runScout } from "@/api/lib/signals/scout";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

const DEADLINE_GENERATION_TIMEOUT_MS = 60_000;
const DEADLINE_MAX_OUTPUT_TOKENS = 2000;
const DEADLINE_SCOUT_MAX_ATTEMPTS = 5;
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

export type RunDocumentDeadlineScoutArgs = {
  sourceRunId: SafeId<"documentProcessingRun">;
};

type ClaimedRun = typeof documentProcessingRuns.$inferSelect;

const claimRun = async (
  sourceRunId: SafeId<"documentProcessingRun">,
): Promise<ClaimedRun | null> => {
  const claimed = await rootDb
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

const resolveActorUserId = async (
  run: ClaimedRun,
): Promise<SafeId<"user"> | null> => {
  const candidates = await rootDb
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

const loadCurrentSource = async (run: ClaimedRun) => {
  const rows = await rootDb
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
  errorCode,
  run,
  status,
}: {
  errorCode: string | null;
  run: ClaimedRun;
  status: "pending" | "succeeded" | "failed" | "cancelled";
}): Promise<void> => {
  await rootDb
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

/**
 * Read one immutable processing result and surface explicit dated obligations.
 * PostgreSQL owns claiming and retry state; a BullMQ job is only a wake-up.
 */
export const runDocumentDeadlineScout = async ({
  sourceRunId,
}: RunDocumentDeadlineScoutArgs): Promise<void> => {
  const run = await claimRun(sourceRunId);
  if (!run) {
    return;
  }

  const actorUserId = await resolveActorUserId(run);
  if (!actorUserId) {
    await settleRun({
      errorCode: DEADLINE_SCOUT_ERROR_CODE.NO_ACTOR,
      run,
      status: "failed",
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

  const observed = await Result.tryPromise(
    async () =>
      await runScout({
        db: scopedDb,
        organizationId: run.organizationId,
        scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
        observe: async () => {
          const source = await loadCurrentSource(run);
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

          const orgAIConfig = await loadOrgAIConfig(run.organizationId);
          const analytics = createTanStackAIAnalyticsCallbacks({
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
            role: "chat",
            organizationId: run.organizationId,
            tenantWorkspaceIds: [run.workspaceId],
            orgAIConfig,
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
          return current.length === 1;
        },
      }),
  );

  if (Result.isError(observed)) {
    await settleRun({
      errorCode: DEADLINE_SCOUT_ERROR_CODE.OBSERVATION_FAILED,
      run,
      status:
        run.deadlineScoutAttemptCount >= DEADLINE_SCOUT_MAX_ATTEMPTS
          ? "failed"
          : "pending",
    });
    throw new DocumentDeadlineScoutError({
      code: DEADLINE_SCOUT_ERROR_CODE.OBSERVATION_FAILED,
      message: "Document deadline observation failed",
      cause: observed.error,
    });
  }

  await settleRun({
    errorCode: observed.value.observationAccepted
      ? null
      : DEADLINE_SCOUT_ERROR_CODE.SOURCE_SUPERSEDED,
    run,
    status: observed.value.observationAccepted ? "succeeded" : "cancelled",
  });
};
