import { SIGNAL_KIND, SUGGESTION_KIND } from "@stll/api-contract/signals";

import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import { resolveCaching } from "@/api/lib/ai-config";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
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
import { runScout, SCOUT_KEY } from "@/api/lib/signals/scout";
import { generateTanStackObjectForRole } from "@/api/lib/tanstack-ai-generate";

const DEADLINE_GENERATION_TIMEOUT_MS = 60_000;
const DEADLINE_MAX_OUTPUT_TOKENS = 2000;

export const documentScoutsEnabled = (): boolean =>
  env.isDev || env.FEATURE_INBOX_DOCUMENT_SCOUTS;

export type RunDocumentDeadlineScoutArgs = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  /** Who the AI usage settles against; falls back to the workspace creator. */
  requestedBy: SafeId<"user"> | null;
};

const resolveActorUserId = async (
  args: RunDocumentDeadlineScoutArgs,
): Promise<SafeId<"user"> | null> => {
  if (args.requestedBy) {
    return args.requestedBy;
  }
  // No request identity exists yet at this point, so the RLS-exempt handle
  // resolves the fallback actor; every later read runs tenant-scoped.
  const workspace = await rootDb.query.workspaces.findFirst({
    where: {
      id: { eq: args.workspaceId },
      organizationId: { eq: args.organizationId },
    },
    columns: { leadUserId: true },
  });
  return workspace?.leadUserId
    ? brandPersistedUserId(workspace.leadUserId)
    : null;
};

/**
 * Read a processed document and surface explicit dated obligations as
 * `deadline.detected` signals. Model output is only evidence when its quote
 * occurs verbatim in the text; everything else is dropped.
 */
export const runDocumentDeadlineScout = async (
  args: RunDocumentDeadlineScoutArgs,
): Promise<void> => {
  const { entityId, workspaceId, organizationId } = args;
  const actorUserId = await resolveActorUserId(args);
  if (!actorUserId) {
    logger.warn("scout.document_deadlines.no_actor", {
      "entity.id": entityId,
      "workspace.id": workspaceId,
    });
    return;
  }
  const scopedDb = createRootScopedDb({
    organizationId,
    userId: actorUserId,
    workspaceIds: [workspaceId],
  });
  const safeDb = createRootSafeDb({
    organizationId,
    userId: actorUserId,
    workspaceIds: [workspaceId],
  });

  const row = await scopedDb((tx) =>
    tx.query.extractedContent.findFirst({
      where: { entityId: { eq: entityId } },
      columns: { ciphertext: true, iv: true },
      with: { entity: { columns: { name: true } } },
    }),
  );
  if (!row) {
    return;
  }
  const text = capText(
    await decryptContent(organizationId, row.ciphertext, row.iv),
  );
  if (text.length < DEADLINE_TEXT_MIN_CHARS) {
    return;
  }
  const entityName = row.entity?.name ?? "Document";

  const orgAIConfig = await loadOrgAIConfig(organizationId);
  const analytics = createTanStackAIAnalyticsCallbacks({
    feature: "inbox.deadline-scout",
    modelRole: "chat",
    orgAIConfig,
    properties: {
      organization_id: organizationId,
      workspace_id: workspaceId,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering: {
      actionType: "background",
      organizationId,
      safeDb,
      serviceTier: "flex",
      userId: actorUserId,
      workspaceId,
    },
  });

  const extraction = await generateTanStackObjectForRole({
    role: "chat",
    organizationId,
    tenantWorkspaceIds: [workspaceId],
    orgAIConfig,
    analytics,
    system: DEADLINE_SYSTEM_PROMPT,
    prompt: `Document "${entityName}":\n\n${text}`,
    maxOutputTokens: DEADLINE_MAX_OUTPUT_TOKENS,
    caching: resolveCaching({
      promptCachingEnabled: false,
      role: "chat",
      scopeKey: organizationId,
    }),
    serviceTier: "flex",
    abortSignal: AbortSignal.timeout(DEADLINE_GENERATION_TIMEOUT_MS),
    outputSchema: deadlineExtractionSchema,
  });

  const now = new Date();
  const kept = filterDeadlines(extraction.deadlines, text, now);
  logger.info("scout.document_deadlines.extracted", {
    "entity.id": entityId,
    "scout.extracted": extraction.deadlines.length,
    "scout.kept": kept.length,
  });
  if (kept.length === 0) {
    return;
  }

  const proposed: NewSignal[] = kept.map((deadline) => {
    const dueAt = `${deadline.dueDate}T00:00:00.000Z`;
    return {
      kind: SIGNAL_KIND.DEADLINE_DETECTED,
      scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
      workspaceId,
      severity: deadlineSeverity(deadline.dueDate, now),
      confidence: deadline.confidence,
      title: `${deadline.label} due ${deadline.dueDate}`,
      summary: `${entityName}: "${deadline.quote}"`,
      subject: { type: "entity", workspaceId, entityId },
      evidence: {
        kind: SIGNAL_KIND.DEADLINE_DETECTED,
        dueAt,
        label: deadline.label,
        quote: deadline.quote,
        entityId,
        entityName,
      },
      suggestions: [
        {
          kind: SUGGESTION_KIND.CREATE_DEADLINE,
          workspaceId,
          name: deadline.label,
          dueAt,
        },
        {
          kind: SUGGESTION_KIND.OPEN_CHAT,
          prompt: `What does "${entityName}" require by ${deadline.dueDate} regarding: ${deadline.label}?`,
        },
      ],
      dedupeKey: deadlineDedupeKey(entityId, deadline.dueDate, deadline.label),
    };
  });

  await runScout({
    db: scopedDb,
    organizationId,
    scoutKey: SCOUT_KEY.DOCUMENT_DEADLINES,
    observe: async () => proposed,
  });
};

/**
 * Fire-and-forget entry used by the document-processing worker. Failures are
 * logged and captured; they never affect the processing run's outcome.
 */
export const maybeRunDocumentDeadlineScout = (
  args: RunDocumentDeadlineScoutArgs,
): void => {
  if (!documentScoutsEnabled()) {
    return;
  }
  runDocumentDeadlineScout(args).catch((error: unknown) => {
    captureError(error, {
      scout: SCOUT_KEY.DOCUMENT_DEADLINES,
      entityId: args.entityId,
    });
    logger.error("scout.document_deadlines.failed", {
      "entity.id": args.entityId,
      "workspace.id": args.workspaceId,
      "error.type": errorTag(error),
    });
  });
};
