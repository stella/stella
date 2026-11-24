import { Result, TaggedError } from "better-result";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import { renderDocumentName } from "@stll/api-contract/document-name";
import type { PermissionInput } from "@stll/permissions";

import {
  documentNamingRuns,
  documentProcessingRuns,
  organizationSettings,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import type { RootDatabase, Transaction } from "@/api/db/types";
import { renameEntityHandler } from "@/api/handlers/entities/rename-operation";
import { resolveCaching } from "@/api/lib/ai-config";
import { loadOrgAISettings } from "@/api/lib/ai-config-loader";
import {
  generateArtefact,
  readUnsourcedArtefact,
} from "@/api/lib/ai-generation/provenance";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { hasCurrentActiveWorkspaceMemberPermission } from "@/api/lib/db/member-authority";
import { transition } from "@/api/lib/db/transitions";
import { loadCurrentDeadlineSourceReader } from "@/api/lib/document-content-provenance";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { createModelActionAdmitter } from "@/api/lib/rate-limit/model-action-admission";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";
import {
  createRootMembershipScopedDb,
  createRootSafeDb,
  createRootScopedDb,
} from "@/api/lib/root-scoped-db";
import { resolveActorUserId } from "@/api/lib/scouts/document-deadlines";
import {
  deadlineScanAdmission,
  deadlineScoutFailureStatus,
} from "@/api/lib/scouts/document-deadlines.logic";
import { generateTanStackObjectForTask } from "@/api/lib/tanstack-ai-generate";
import {
  DOCUMENT_NAMING_RENAMED_ERROR_CODE,
  DOCUMENT_NAMING_SYSTEM_PROMPT,
  documentNamingSchema,
  extensionOf,
  NAMING_TEXT_MIN_CHARS,
  namingPrompt,
  namingValues,
} from "@/api/lib/uploads/document-naming/document-naming.logic";
import { DOCUMENT_NAMING_TRANSITIONS } from "@/api/lib/uploads/document-naming/transitions";

const NAMING_GENERATION_TIMEOUT_MS = 60_000;
const NAMING_MAX_OUTPUT_TOKENS = 1024;
const NAMING_PERMISSIONS = {
  entity: ["update"],
} as const satisfies PermissionInput;
const NAMING_ERROR_CODE = {
  NO_ACTOR: "no_actor",
  NAMING_FAILED: "naming_failed",
  NOT_ELIGIBLE: "not_eligible",
  RENAMED: DOCUMENT_NAMING_RENAMED_ERROR_CODE,
} as const;

class DocumentNamingError extends TaggedError("DocumentNamingError")<{
  message: string;
  cause: unknown;
}> {}

type DocumentNamingDb = Pick<
  RootDatabase,
  "select" | "update" | "insert" | "execute" | "transaction"
>;

type ClaimedNaming = typeof documentNamingRuns.$inferSelect;

// Worker bookkeeping; the rename a run leads to is audited on its own.
const unaudited = async () => await Promise.resolve();

const claimNaming = async (
  db: DocumentNamingDb,
  id: SafeId<"documentProcessingRun">,
): Promise<ClaimedNaming | null> =>
  await withAggregateTransaction(db, async (tx) => {
    const [due] = await tx
      .select()
      .from(documentNamingRuns)
      .where(
        and(
          eq(documentNamingRuns.id, id),
          eq(documentNamingRuns.status, "pending"),
          or(
            isNull(documentNamingRuns.skippedUntil),
            lte(documentNamingRuns.skippedUntil, sql`now()`),
          ),
        ),
      )
      .limit(1);
    if (!due) {
      return null;
    }
    const now = new Date();
    const claimed = await transition({
      tx,
      spec: DOCUMENT_NAMING_TRANSITIONS,
      id,
      options: {
        from: ["pending"],
        to: "running",
        fence: due.attempt,
        nextFence: due.attempt + 1,
        set: {
          claimedAt: now,
          errorCode: null,
          skippedUntil: null,
          updatedAt: now,
        },
      },
      recordTransitionAuditEvent: unaudited,
    });
    return claimed.type === "transitioned"
      ? { ...due, attempt: due.attempt + 1, claimedAt: now, status: "running" }
      : null;
  });

type NamingSettlement =
  | {
      to: "succeeded" | "failed" | "cancelled" | "pending";
      errorCode: string | null;
    }
  | { to: "skipped"; skippedUntil: Date };

/** Settle the live claim; a claim recovery took back changes nothing. */
const settleNaming = async (
  db: DocumentNamingDb,
  naming: ClaimedNaming,
  settlement: NamingSettlement,
): Promise<void> => {
  const now = new Date();
  // Stale: recovery took the claim back, and the next claim settles it.
  await withAggregateTransaction(
    db,
    async (tx) =>
      await (settlement.to === "skipped"
        ? transition({
            tx,
            spec: DOCUMENT_NAMING_TRANSITIONS,
            id: naming.id,
            options: {
              from: ["running"],
              to: "pending",
              fence: naming.attempt,
              // A refusal for an exhausted period does not use up an attempt.
              nextFence: Math.max(naming.attempt - 1, 0),
              set: {
                claimedAt: null,
                errorCode: "period_exhausted",
                skippedUntil: settlement.skippedUntil,
                updatedAt: now,
              },
            },
            recordTransitionAuditEvent: unaudited,
          })
        : transition({
            tx,
            spec: DOCUMENT_NAMING_TRANSITIONS,
            id: naming.id,
            options: {
              from: ["running"],
              to: settlement.to,
              fence: naming.attempt,
              set: {
                claimedAt: null,
                errorCode: settlement.errorCode,
                updatedAt: now,
              },
            },
            recordTransitionAuditEvent: unaudited,
          })),
  );
};

const loadNamingSettings = async (
  db: DocumentNamingDb,
  naming: ClaimedNaming,
) => {
  const rows = await db
    .select({
      pattern: organizationSettings.documentNamePattern,
      matterNumber: workspaces.reference,
      enabled: workspaces.documentNamingEnabled,
    })
    .from(workspaces)
    .innerJoin(
      organizationSettings,
      eq(organizationSettings.organizationId, workspaces.organizationId),
    )
    .where(
      and(
        eq(workspaces.id, naming.workspaceId),
        eq(workspaces.organizationId, naming.organizationId),
      ),
    )
    .limit(1);
  const settings = rows.at(0);
  return settings?.enabled && settings.pattern !== null
    ? { pattern: settings.pattern, matterNumber: settings.matterNumber }
    : null;
};

type SuggestedName =
  | { type: "named"; name: string | null }
  | { type: "skipped"; skippedUntil: Date };

type SuggestDocumentNameArgs = {
  naming: ClaimedNaming;
  sourceRun: typeof documentProcessingRuns.$inferSelect;
  settings: { pattern: string; matterNumber: string };
  userId: SafeId<"user">;
  database: RlsDatabase<Transaction> | undefined;
  admit: typeof withActionAdmission | undefined;
};

/** Read the document, ask the model for its date, type and title, and render the pattern. */
const suggestDocumentName = async ({
  naming,
  sourceRun,
  settings,
  userId,
  database,
  admit,
}: SuggestDocumentNameArgs): Promise<Result<SuggestedName, unknown>> => {
  const member = { organizationId: naming.organizationId, userId };
  const pinned = { ...member, workspaceIds: [naming.workspaceId] };
  const inputDb = createRootMembershipScopedDb(member, database);
  const writeDb = createRootScopedDb(pinned, database);
  const writeSafeDb = createRootSafeDb(pinned, database);
  const authorized = await inputDb(
    async (tx) =>
      await hasCurrentActiveWorkspaceMemberPermission({
        db: tx,
        organizationId: naming.organizationId,
        userId,
        workspaceId: naming.workspaceId,
        permissions: NAMING_PERMISSIONS,
      }),
  );
  const source = authorized
    ? await inputDb(
        async (tx) =>
          await loadCurrentDeadlineSourceReader(
            tx,
            "document-naming",
            sourceRun,
          ),
      )
    : null;
  const text = source ? await source.readText() : "";
  if (text.trim().length < NAMING_TEXT_MIN_CHARS) {
    return Result.ok({ type: "named", name: null });
  }

  const aiSettings = await inputDb(
    async (tx) => await loadOrgAISettings(tx, member),
  );
  if (Result.isError(aiSettings)) {
    return Result.err(aiSettings.error);
  }
  const { orgAIConfig, managedAIResidency } = aiSettings.value;
  const admitted = await createModelActionAdmitter({
    organizationId: naming.organizationId,
    userId,
    organizationStateDb: writeDb,
    actionKind: "documents.suggest-name",
    ...(admit === undefined ? {} : { admit }),
  })(
    async ({ admission }) =>
      await generateArtefact({
        generator:
          "apps/api/src/lib/uploads/document-naming/document-naming.ts",
        // The document's own text is the only input; no stored decision feeds it.
        sources: { decisionIds: [], inputs: [] },
        generate: async () =>
          await generateTanStackObjectForTask({
            userId: admission.userId,
            dataClass: "customer",
            task: "chat",
            organizationId: naming.organizationId,
            admission,
            tenantWorkspaceIds: [naming.workspaceId],
            orgAIConfig,
            managedAIResidency,
            analytics: createTanStackAIAnalyticsCallbacks({
              dataClass: "customer",
              feature: "documents.naming",
              modelTask: "chat",
              orgAIConfig,
              modelTier: admission.modelTier,
              properties: {
                organization_id: naming.organizationId,
                workspace_id: naming.workspaceId,
              },
              traceId: Bun.randomUUIDv7(),
              usageMetering: {
                actionType: "background",
                organizationId: naming.organizationId,
                safeDb: writeSafeDb,
                serviceTier: "flex",
                userId,
                workspaceId: naming.workspaceId,
              },
            }),
            system: DOCUMENT_NAMING_SYSTEM_PROMPT,
            prompt: namingPrompt(naming.sourceName, text),
            maxOutputTokens: NAMING_MAX_OUTPUT_TOKENS,
            caching: resolveCaching({
              promptCachingEnabled: false,
              task: "chat",
              scopeKey: naming.organizationId,
            }),
            serviceTier: "flex",
            deadlineMs: NAMING_GENERATION_TIMEOUT_MS,
            outputSchema: documentNamingSchema,
          }),
      }),
  );
  if (Result.isError(admitted)) {
    const admission = deadlineScanAdmission(admitted.error);
    return admission.type === "period_exhausted"
      ? Result.ok({ type: "skipped", skippedUntil: admission.skippedUntil })
      : Result.err(admitted.error);
  }
  return admitted.value.map((artefact) => ({
    type: "named" as const,
    name: renderDocumentName({
      pattern: settings.pattern,
      values: namingValues(
        readUnsourcedArtefact(artefact),
        settings.matterNumber,
      ),
      extension: extensionOf(naming.sourceName),
    }),
  }));
};

export type RunDocumentNamingArgs = {
  db: DocumentNamingDb;
  sourceRunId: SafeId<"documentProcessingRun">;
  /** The RLS database the run's member scopes open; the application's when omitted. */
  database?: RlsDatabase<Transaction>;
  /** The naming's action admission; `withActionAdmission` when omitted. */
  admit?: typeof withActionAdmission;
};

/**
 * Ask the model for the document's date, type and title, render the
 * organization's pattern and rename the document, unless someone renamed it
 * since it was uploaded. PostgreSQL owns claiming and retries; a BullMQ job
 * is only a wake-up.
 */
export const runDocumentNaming = async ({
  db,
  sourceRunId,
  database,
  admit,
}: RunDocumentNamingArgs): Promise<Result<void, DocumentNamingError>> => {
  const naming = await claimNaming(db, sourceRunId);
  if (!naming) {
    return Result.ok(undefined);
  }
  const [sourceRun] = await db
    .select()
    .from(documentProcessingRuns)
    .where(eq(documentProcessingRuns.id, sourceRunId))
    .limit(1);
  const settings = await loadNamingSettings(db, naming);
  if (!sourceRun || !settings) {
    await settleNaming(db, naming, {
      to: "cancelled",
      errorCode: NAMING_ERROR_CODE.NOT_ELIGIBLE,
    });
    return Result.ok(undefined);
  }

  const userId = await resolveActorUserId(db, sourceRun);
  if (!userId) {
    await settleNaming(db, naming, {
      to: "failed",
      errorCode: NAMING_ERROR_CODE.NO_ACTOR,
    });
    return Result.ok(undefined);
  }
  const suggested = (
    await Result.tryPromise(
      async () =>
        await suggestDocumentName({
          naming,
          sourceRun,
          settings,
          userId,
          database,
          admit,
        }),
    )
  ).andThen((outcome) => outcome);

  if (Result.isError(suggested)) {
    await settleNaming(db, naming, {
      to: deadlineScoutFailureStatus(naming.attempt, suggested.error),
      errorCode: NAMING_ERROR_CODE.NAMING_FAILED,
    });
    return Result.err(
      new DocumentNamingError({
        message: "Document naming failed",
        cause: suggested.error,
      }),
    );
  }
  if (suggested.value.type === "skipped") {
    await settleNaming(db, naming, {
      to: "skipped",
      skippedUntil: suggested.value.skippedUntil,
    });
    return Result.ok(undefined);
  }

  const { name } = suggested.value;
  const writeSafeDb = createRootSafeDb(
    {
      organizationId: naming.organizationId,
      userId,
      workspaceIds: [naming.workspaceId],
    },
    database,
  );
  if (name === null || name === naming.sourceName) {
    await settleNaming(db, naming, { to: "succeeded", errorCode: null });
    return Result.ok(undefined);
  }
  const renamed = await Result.gen(() =>
    renameEntityHandler({
      safeDb: writeSafeDb,
      workspaceId: naming.workspaceId,
      recordAuditEvent: createBackgroundAuditRecorder({
        organizationId: naming.organizationId,
        workspaceId: naming.workspaceId,
        userId,
        execution: {
          performer: { type: "user", id: userId },
          trigger: {
            type: "system",
            source: "document_naming",
            sourceId: naming.id,
          },
        },
      }),
      body: {
        entityId: naming.entityId,
        name,
        expectedName: naming.sourceName,
      },
    }),
  );
  if (Result.isError(renamed)) {
    const { error } = renamed;
    if (HandlerError.is(error) && error.status === 409) {
      await settleNaming(db, naming, {
        to: "cancelled",
        errorCode: NAMING_ERROR_CODE.RENAMED,
      });
      return Result.ok(undefined);
    }
    await settleNaming(db, naming, {
      to: deadlineScoutFailureStatus(naming.attempt, error),
      errorCode: NAMING_ERROR_CODE.NAMING_FAILED,
    });
    return Result.err(
      new DocumentNamingError({
        message: "Document rename failed",
        cause: error,
      }),
    );
  }
  await settleNaming(db, naming, { to: "succeeded", errorCode: null });
  // The rename skipped the route that tells open tabs; tell them here.
  broadcastWorkspaceResourceUpdated(
    naming.workspaceId,
    resourceRef({ type: RESOURCE_TYPE.ENTITY, id: naming.entityId }),
  );
  return Result.ok(undefined);
};
