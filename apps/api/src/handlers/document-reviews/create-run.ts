/**
 * Start a durable document review.
 *
 * Everything the run will be judged by is pinned here, before any model call:
 * the target document's version and content hash, each reference's version and
 * hash, the playbook snapshot, and the confirmed topic list. The worker then
 * executes from the row alone, so the result stays intelligible after the
 * playbook, the references, or the document move on.
 */

import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { documentReviewRuns } from "@/api/db/schema";
import { resolveReviewSelection } from "@/api/handlers/document-reviews/review-selection";
import { validateReviewTopics } from "@/api/handlers/document-reviews/review-topics";
import { createDocumentReviewRunBodySchema } from "@/api/handlers/document-reviews/schemas";
import type { DocumentReviewTopic } from "@/api/handlers/document-reviews/schemas";
import {
  assertRunSizeConfirmedForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { loadLatestApprovedVersion } from "@/api/lib/document-review/approved-playbook-versions";
import type { ReviewPerspective } from "@/api/lib/document-review/contract";
import { resolvePlaybookPin } from "@/api/lib/document-review/resolve-playbook-pin";
import { DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES } from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewRunBasis,
  PinnedPlaybook,
  PinnedReference,
} from "@/api/lib/document-review/run-contract";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import { enqueueDocumentReviewRun } from "@/api/lib/document-review/run-queue";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getTanStackTextModelInfoForRole } from "@/api/lib/tanstack-ai-models";
import { estimateDocumentRunUnits } from "@/api/lib/usage/run-estimate";

const config = {
  description:
    "Start an asynchronous review of one document against a playbook and/or reference documents. Returns a run ID to poll.",
  permissions: { workspace: ["read"] },
  // Creating a run writes a row and enqueues metered model work, so it must
  // never be reachable through a read-only consent even though the permission
  // gate that fronts the whole review surface is a workspace read.
  access: "write",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({}),
  body: createDocumentReviewRunBodySchema,
} satisfies HandlerConfig;

/** Build the discriminated basis from what the request actually pinned. */
const buildBasis = ({
  playbook,
  references,
  perspective,
}: {
  playbook: PinnedPlaybook | null;
  references: readonly PinnedReference[];
  perspective: ReviewPerspective;
}): DocumentReviewRunBasis | null => {
  if (playbook !== null && references.length > 0) {
    return {
      type: "combined",
      playbook,
      references: [...references],
      perspective,
    };
  }
  if (playbook !== null) {
    return { type: "playbook", playbook };
  }
  if (references.length > 0) {
    return { type: "references", references: [...references], perspective };
  }
  return null;
};

const createDocumentReviewRun = createSafeHandler(
  config,
  async function* ({
    body,
    orgAIConfig,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const organizationId = session.activeOrganizationId;

    const topics: DocumentReviewTopic[] = body.topics;
    const validTopics = validateReviewTopics(topics, "comparison");
    if (Result.isError(validTopics)) {
      return Result.err(validTopics.error);
    }

    const target = { ...body.target, workspaceId };
    const entityIds = [
      target.entityId,
      ...body.references.map((reference) => reference.entityId),
    ];
    // References may come from other matters. The membership-scoped
    // transaction only returns rows from matters the caller can read, and the
    // selection then holds each row to the matter its reference named, so an
    // inaccessible or misattributed document resolves to "not found".
    const entities = yield* Result.await(
      safeDb((tx) =>
        tx.query.entities.findMany({
          where: { id: { in: [...new Set(entityIds)] } },
          columns: { id: true, name: true, workspaceId: true },
          limit: body.references.length + 1,
          with: {
            currentVersion: {
              columns: { id: true },
              with: { fields: { columns: { id: true, content: true } } },
            },
          },
        }),
      ),
    );

    const selection = resolveReviewSelection({
      target,
      references: body.references,
      entities,
    });
    if (Result.isError(selection)) {
      return Result.err(selection.error);
    }

    const referenceWorkspaceIds = [
      ...new Set(
        selection.value.references.map((reference) => reference.workspaceId),
      ),
    ];
    const referenceWorkspaces = yield* Result.await(
      safeDb((tx) =>
        referenceWorkspaceIds.length === 0
          ? Promise.resolve([])
          : tx.query.workspaces.findMany({
              where: { id: { in: referenceWorkspaceIds } },
              columns: { id: true, name: true },
              limit: referenceWorkspaceIds.length,
            }),
      ),
    );
    const workspaceNameById = new Map(
      referenceWorkspaces.map((workspace) => [workspace.id, workspace.name]),
    );
    const nameByEntityId = new Map(
      entities.map((entity) => [entity.id, entity.name]),
    );
    const references: PinnedReference[] = [];
    for (const reference of selection.value.references) {
      const name = nameByEntityId.get(reference.entityId);
      const workspaceName = workspaceNameById.get(reference.workspaceId);
      if (name === undefined || workspaceName === undefined) {
        // Selection resolved this entity from the same rows, so a miss here
        // means the two disagree about what was loaded.
        return panic("Resolved review reference has no loaded entity row");
      }
      references.push({
        workspaceId: reference.workspaceId,
        workspaceName,
        entityId: reference.entityId,
        fileFieldId: reference.file.fileFieldId,
        entityVersionId: reference.entityVersionId,
        contentSha256: reference.file.sha256Hex,
        name,
      });
    }

    const playbookId = body.playbookId;
    let playbook: PinnedPlaybook | null = null;
    if (playbookId !== undefined) {
      const loaded = yield* Result.await(
        safeDb(async (tx) => {
          // RLS scopes both reads to the caller's organization.
          const definition = await tx.query.playbookDefinitions.findFirst({
            where: { id: { eq: playbookId } },
            columns: { id: true, name: true, positions: true },
          });
          if (!definition) {
            return null;
          }
          return {
            definition,
            latestApprovedVersion: await loadLatestApprovedVersion({
              tx,
              organizationId,
              playbookDefinitionId: playbookId,
            }),
          };
        }),
      );
      if (loaded === null) {
        return Result.err(
          new HandlerError({ status: 404, message: "Playbook not found" }),
        );
      }
      playbook = resolvePlaybookPin(loaded);
    }

    const basis = buildBasis({
      playbook,
      references,
      perspective: body.perspective,
    });
    if (basis === null) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "A review needs a playbook, a reference document, or both.",
        }),
      );
    }

    const plan = planReviewRun({ basis, topics });
    if (plan.expectedFindingCount === 0) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "None of the confirmed topics can be reviewed.",
        }),
      );
    }

    // Size the whole run before pinning it: every reviewed file's bytes
    // through the review model's rate, one output budget per planned
    // finding. Large runs need the client to restate the estimate.
    const reviewModel = getTanStackTextModelInfoForRole("pdf", orgAIConfig, {
      organizationId,
    });
    const inputBytes =
      selection.value.target.fileSizeBytes +
      selection.value.references.reduce(
        (total, reference) => total + reference.fileSizeBytes,
        0,
      );
    const sizeError = await assertRunSizeConfirmedForHandler({
      metering: { actionType: "doc_review", modelRole: "pdf" },
      estimatedUnits: estimateDocumentRunUnits({
        modelId: reviewModel.modelId,
        actionType: "doc_review",
        storedInputBytes: inputBytes,
        plannedOutputs: plan.expectedFindingCount,
        serviceTier: "standard",
      }),
      confirmedUnits: body.confirmedUnits,
      organizationId,
      orgAIConfig,
      workspaceId,
      userId: user.id,
      safeDb,
    });
    if (sizeError) {
      return Result.err(sizeError);
    }

    const pinnedTarget = selection.value.target;
    const runId = createSafeId<"documentReviewRun">();
    const inserted = yield* Result.await(
      safeDb(async (tx) => {
        // One unfinished review per document: a second one would spend twice
        // and race the first to the same findings. The partial unique index
        // backs this up if two requests pass the check together.
        const active = await tx
          .select({ id: documentReviewRuns.id })
          .from(documentReviewRuns)
          .where(
            and(
              eq(documentReviewRuns.workspaceId, workspaceId),
              eq(documentReviewRuns.entityId, pinnedTarget.entityId),
              eq(documentReviewRuns.fileFieldId, pinnedTarget.file.fileFieldId),
              inArray(documentReviewRuns.status, [
                ...DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
              ]),
            ),
          )
          .limit(1);
        if (active.length > 0) {
          return false;
        }

        await tx.insert(documentReviewRuns).values({
          id: runId,
          organizationId,
          workspaceId,
          entityId: pinnedTarget.entityId,
          fileFieldId: pinnedTarget.file.fileFieldId,
          entityVersionId: pinnedTarget.entityVersionId,
          contentSha256: pinnedTarget.file.sha256Hex,
          playbookDefinitionId: playbook?.definitionId,
          basis,
          topics,
          status: "queued",
          total: plan.expectedFindingCount,
          requestedBy: user.id,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN,
          resourceId: runId,
          metadata: {
            basisType: basis.type,
            expectedFindingCount: plan.expectedFindingCount,
            playbookProvenance:
              playbook === null ? "none" : playbook.provenance,
            referenceCount: references.length,
          },
        });
        return true;
      }),
    );

    if (!inserted) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This document is already being reviewed.",
        }),
      );
    }

    const enqueued = await Result.tryPromise({
      try: async () =>
        await enqueueDocumentReviewRun({
          runId,
          workspaceId,
          organizationId,
          userId: user.id,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(enqueued)) {
      // A never-enqueued run must not hold the document's active slot, so mark
      // it failed immediately rather than waiting for the orphan reconciler.
      yield* Result.await(
        safeDb(async (tx) => {
          // audit: skip — status bookkeeping on the run row audited at insert.
          await tx
            .update(documentReviewRuns)
            .set({
              status: "failed",
              errorCode: "enqueue_failed",
              finishedAt: new Date(),
            })
            .where(eq(documentReviewRuns.id, runId));
        }),
      );
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to start the review.",
          cause: enqueued.error,
        }),
      );
    }

    return Result.ok({ runId });
  },
);

export default createDocumentReviewRun;
