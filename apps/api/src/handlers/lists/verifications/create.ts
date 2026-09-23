/**
 * Start verifying one document against one list's facts. The document
 * version and the facts are pinned when the run starts; the checking itself
 * runs in the background and is read back with lists.verifications.get.
 */

import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { legalListVerificationRuns } from "@/api/db/schema";
import {
  assertRunSizeConfirmedForHandler,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { VERIFICATION_RUN_ACTIVE_STATUSES } from "@/api/lib/lists/verification/contract";
import { readVerificationEvidence } from "@/api/lib/lists/verification/evidence";
import { VERIFICATION_MODEL_ROLE } from "@/api/lib/lists/verification/model-call";
import { enqueueListVerificationRun } from "@/api/lib/lists/verification/run-queue";
import { getTanStackTextModelInfoForRole } from "@/api/lib/tanstack-ai-models";
import { estimateDocumentRunUnits } from "@/api/lib/usage/run-estimate";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const bodySchema = t.Object({
  listId: tSafeId("legalList"),
  entityId: tSafeId("entity"),
  fileFieldId: tSafeId("field"),
  /** The estimate the caller accepted, when a large run asked for one. */
  confirmedUnits: t.Optional(t.Integer({ minimum: 0 })),
});

const config = {
  description:
    "Start checking one document (DOCX, PDF, or a file with a PDF " +
    "rendition) against the facts of one list. Every claim the document " +
    "makes is found and, when factual, graded against the list's facts " +
    "(held facts are left out). Returns a run id; read the result with " +
    "lists.verifications.get. A document holds one unfinished verification " +
    "at a time.",
  permissions: { workspace: ["read"], entity: ["update"] },
  access: "write",
  mcp: { type: "capability", reason: "document_processing" },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

/**
 * Claims expected per prompt byte, for sizing a run before its document is
 * read. A heuristic: one claim per ~100 tokens of prose.
 */
const PROMPT_BYTES_PER_EXPECTED_CLAIM = 400;
const PROMPT_BYTES_PER_STORED_BYTE = 4;

const isVerifiableFile = (content: {
  mimeType: string;
  pdfFileId: string | null;
}): boolean =>
  content.mimeType === DOCX_MIME_TYPE ||
  content.mimeType === PDF_MIME_TYPE ||
  content.pdfFileId !== null;

const createVerification = createSafeHandler(
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
    const { listId, entityId, fileFieldId } = body;

    const target = yield* Result.await(
      safeDb(async (tx) => {
        const entity = await tx.query.entities.findFirst({
          where: { id: { eq: entityId }, workspaceId: { eq: workspaceId } },
          columns: { id: true, name: true },
          with: {
            currentVersion: {
              columns: { id: true },
              with: { fields: { columns: { id: true, content: true } } },
            },
          },
        });
        const list = await tx.query.legalLists.findFirst({
          where: { id: { eq: listId }, workspaceId: { eq: workspaceId } },
          columns: { id: true },
        });
        return { entity, list };
      }),
    );
    const version = target.entity?.currentVersion;
    const field = version?.fields.find((candidate) => candidate.id === fileFieldId);
    if (
      target.list === undefined ||
      version === undefined ||
      version === null ||
      field?.content.type !== "file"
    ) {
      return Result.err(
        new HandlerError({ status: 404, message: "List or document not found" }),
      );
    }
    const file = field.content;
    if (!isVerifiableFile(file)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message:
            "Only DOCX files, PDFs and files with a PDF rendition can be verified.",
        }),
      );
    }

    const evidence = yield* Result.await(
      safeDb(
        async (tx) =>
          await readVerificationEvidence({ tx, workspaceId, listId }),
      ),
    );
    if (evidence.type === "too-many-facts") {
      return Result.err(
        new HandlerError({
          status: 422,
          message:
            "This list has more facts than one verification can check; split it or hold facts that do not bear on the document.",
        }),
      );
    }

    const model = getTanStackTextModelInfoForRole(
      VERIFICATION_MODEL_ROLE,
      orgAIConfig,
      { organizationId },
    );
    const sizeError = await assertRunSizeConfirmedForHandler({
      metering: { actionType: "doc_review", modelRole: VERIFICATION_MODEL_ROLE },
      estimatedUnits: estimateDocumentRunUnits({
        modelId: model.modelId,
        actionType: "doc_review",
        storedInputBytes: file.sizeBytes,
        plannedOutputs: Math.ceil(
          (file.sizeBytes * PROMPT_BYTES_PER_STORED_BYTE) /
            PROMPT_BYTES_PER_EXPECTED_CLAIM,
        ),
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

    const runId = createSafeId<"legalListVerificationRun">();
    const inserted = yield* Result.await(
      safeDb(async (tx) => {
        // One unfinished verification per document; the partial unique index
        // makes a lost race impossible rather than unlikely.
        const active = await tx
          .select({ id: legalListVerificationRuns.id })
          .from(legalListVerificationRuns)
          .where(
            and(
              eq(legalListVerificationRuns.workspaceId, workspaceId),
              eq(legalListVerificationRuns.entityId, entityId),
              eq(legalListVerificationRuns.fileFieldId, fileFieldId),
              inArray(legalListVerificationRuns.status, [
                ...VERIFICATION_RUN_ACTIVE_STATUSES,
              ]),
            ),
          )
          .limit(1);
        if (active.length > 0) {
          return false;
        }
        await tx.insert(legalListVerificationRuns).values({
          id: runId,
          organizationId,
          workspaceId,
          entityId,
          fileFieldId,
          entityVersionId: version.id,
          contentSha256: file.sha256Hex,
          evidence: evidence.evidence,
          status: "queued",
          requestedBy: user.id,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
          resourceId: runId,
          metadata: {
            listId,
            entityId,
            fileFieldId,
            documentName: target.entity?.name ?? null,
            factCount: evidence.evidence.facts.length,
          },
        });
        return true;
      }),
    );
    if (!inserted) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This document is already being verified.",
        }),
      );
    }

    const enqueued = await Result.tryPromise({
      try: async () =>
        await enqueueListVerificationRun({
          runId,
          workspaceId,
          organizationId,
          userId: user.id,
        }),
      catch: (cause) => cause,
    });
    if (Result.isError(enqueued)) {
      // A never-enqueued run must not hold the document's active slot.
      yield* Result.await(
        safeDb(async (tx) => {
          // audit: skip — failure bookkeeping on the run audited just above.
          await tx
            .update(legalListVerificationRuns)
            .set({
              status: "failed",
              errorCode: "enqueue_failed",
              finishedAt: new Date(),
            })
            .where(
              and(
                eq(legalListVerificationRuns.id, runId),
                eq(legalListVerificationRuns.workspaceId, workspaceId),
              ),
            );
        }),
      );
      return Result.err(
        new HandlerError({
          status: 500,
          message: "The verification could not be started.",
          cause: enqueued.error,
        }),
      );
    }

    return Result.ok({ runId, status: "queued" as const });
  },
);

export default createVerification;
