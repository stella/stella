/**
 * Start a durable document review.
 *
 * Everything the run will be judged by is pinned here, before any model call:
 * the target document's version and content hash, each reference's version and
 * hash, and the confirmed position list. When the reviewer picked a playbook,
 * the pin records which one and whether it was approved; when the positions
 * were proposed for this run alone, the pin is ephemeral and carries no
 * definition. Either way the worker executes from the row alone, so the result
 * stays intelligible after the playbook, the references, or the document move
 * on.
 */

import { panic, Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { documentReviewRuns } from "@/api/db/schema";
import { resolveReviewSelection } from "@/api/handlers/document-reviews/review-selection";
import { createDocumentReviewRunBodySchema } from "@/api/handlers/document-reviews/schemas";
import {
  assertRunSizeConfirmedForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { workspaceParams } from "@/api/lib/custom-schema";
import { loadLatestApprovedVersion } from "@/api/lib/document-review/approved-playbook-versions";
import {
  readableReferencePassageIds,
  referencePassageIds,
} from "@/api/lib/document-review/reference-passages";
import { resolvePlaybookPin } from "@/api/lib/document-review/resolve-playbook-pin";
import {
  DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES,
  DOCUMENT_REVIEW_RUN_EXECUTOR,
  PLAYBOOK_PIN_PROVENANCE,
} from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewRunBasis,
  PinnedPlaybook,
  PinnedReference,
} from "@/api/lib/document-review/run-contract";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import { enqueueDocumentReviewRun } from "@/api/lib/document-review/run-queue";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { getTanStackTextModelInfoForRole } from "@/api/lib/tanstack-ai-models";
import { estimateDocumentRunUnits } from "@/api/lib/usage/run-estimate";
import type { Position } from "@/api/lib/workflow/playbook-positions";
import { findDuplicatePositionSourceId } from "@/api/lib/workflow/playbook-positions-validation";

const config = {
  description:
    "Start an asynchronous review of one document against a confirmed list of positions. Returns a run ID to poll.",
  // entity:update because every run processes an existing target document
  // (and, when applied, writes edits back onto it) the same way
  // entities/ocr/create.ts does; workspace:read alone would let a member
  // with no document-processing grant start metered AI review runs.
  permissions: { workspace: ["read"], entity: ["update"] },
  // Creating a run writes a row and enqueues metered model work, so it must
  // never be reachable through a read-only consent even though the permission
  // gate that fronts the whole review surface is a workspace read.
  access: "write",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({}),
  body: createDocumentReviewRunBodySchema,
} satisfies HandlerConfig;

/**
 * The pin for a position list that was never saved as a playbook. The
 * positions are still pinned by value, exactly as an approved snapshot is, so
 * the run reads the same way; what it lacks is a definition to be newer than
 * it, which `provenance` says outright rather than leaving to a null check.
 */
const EPHEMERAL_PLAYBOOK_NAME = "Positions confirmed for this review";

const ephemeralPin = (positions: readonly Position[]): PinnedPlaybook => ({
  definitionId: null,
  versionId: null,
  provenance: PLAYBOOK_PIN_PROVENANCE.EPHEMERAL,
  definitionSnapshot: {
    name: EPHEMERAL_PLAYBOOK_NAME,
    positions: { version: 3, items: [...positions] },
  },
});

const createDocumentReviewRun = createSafeHandler(
  config,
  async function* ({
    body,
    memberRole,
    orgAIConfig,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const organizationId = session.activeOrganizationId;

    const positions: Position[] = body.positions;
    const duplicateSourceId = findDuplicatePositionSourceId({
      version: 3,
      items: positions,
    });
    if (duplicateSourceId !== null) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Positions must have unique sourceIds",
        }),
      );
    }

    // A reference-derived position pins passages by id, and the grader reads
    // those rows with service access on this caller's behalf. So every pinned
    // passage must be one the caller's own transaction can read now; a
    // passage from a matter they cannot open is refused, not graded blind.
    const pinnedPassageIds = referencePassageIds(positions);
    const readablePassageIds = yield* Result.await(
      safeDb((tx) => readableReferencePassageIds(tx, pinnedPassageIds)),
    );
    if (pinnedPassageIds.some((id) => !readablePassageIds.has(id))) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "A position quotes a reference passage you cannot read.",
        }),
      );
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
      safeDb(async (tx) =>
        referenceWorkspaceIds.length === 0
          ? []
          : await tx.query.workspaces.findMany({
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

    // The named playbook only supplies provenance: which definition these
    // positions belong to, and whether it was approved. What is graded is the
    // confirmed list in the request, which the reviewer may have edited or
    // extended with reference-derived positions.
    const { playbookId } = body;
    let playbook: PinnedPlaybook;
    if (playbookId === null) {
      playbook = ephemeralPin(positions);
    } else {
      // The config's blanket entity:update grant covers a review whose
      // positions were confirmed for this run alone; naming a playbook
      // additionally requires playbook:apply, mirrored here the way
      // playbooks/run.ts's config permission and the MCP run_playbook tool's
      // in-handler check both require it, since a request may leave
      // playbookId null and the top-level gate cannot demand it
      // unconditionally.
      if (!hasMemberPermission(memberRole, { playbook: ["apply"] })) {
        return Result.err(
          new HandlerError({ status: 403, message: "Forbidden" }),
        );
      }
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
      const pin = resolvePlaybookPin(loaded);
      playbook = {
        definitionId: pin.definitionId,
        versionId: pin.versionId,
        provenance: pin.provenance,
        definitionSnapshot: {
          name: pin.definitionSnapshot.name,
          positions: { version: 3, items: positions },
        },
      };
    }

    const basis: DocumentReviewRunBasis = {
      playbook,
      references,
      perspective: body.perspective,
    };

    const plan = planReviewRun({
      basis,
      executor: DOCUMENT_REVIEW_RUN_EXECUTOR.WORKER,
    });
    if (plan.expectedFindingCount === 0) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "None of the confirmed positions can be reviewed.",
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
    const targetDocumentName =
      nameByEntityId.get(pinnedTarget.entityId) ?? null;
    // The side the run judged from, by role alone: the party's name is the
    // document's business, and the audit record does not need it to say what
    // the review was.
    const perspectiveRole =
      basis.perspective.type === "party" ? basis.perspective.role : null;
    // Null for positions confirmed for this run alone: those have no playbook
    // to name, and `referenceCount` says what they were drawn from instead.
    const playbookBasisName =
      playbook.provenance === PLAYBOOK_PIN_PROVENANCE.EPHEMERAL
        ? null
        : playbook.definitionSnapshot.name;
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
          playbookDefinitionId: playbook.definitionId,
          basis,
          // Pinned by value with everything else the reviewer confirmed: what
          // the proposal left uncompared is part of what this run covered.
          skipped: body.skipped,
          status: "queued",
          total: plan.expectedFindingCount,
          requestedBy: user.id,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN,
          resourceId: runId,
          // The reviewed document and what the run was judged against, pinned
          // the way the run row pins them: the matter's activity names the
          // document and its basis without re-reading a row that may be gone.
          metadata: {
            documentName: targetDocumentName,
            entityId: pinnedTarget.entityId,
            expectedFindingCount: plan.expectedFindingCount,
            fileFieldId: pinnedTarget.file.fileFieldId,
            perspectiveRole,
            playbookName: playbookBasisName,
            playbookProvenance: playbook.provenance,
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
