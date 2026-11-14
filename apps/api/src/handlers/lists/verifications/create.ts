/**
 * Start verifying one document against one list's facts. The document
 * version and the facts are pinned when the run starts; the checking itself
 * runs in the background and is read back with lists.verifications.get.
 */

import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { decisionParagraphRangeSchema } from "@stll/api-contract/decision-paragraph-range";
import { VERIFICATION_SCOPE_REFUSALS } from "@stll/api-contract/verification-scope";
import type { ParagraphRange } from "@stll/legal-ast/paragraph-range";

import type { SafeDb } from "@/api/db/safe-db";
import { legalListVerificationRuns } from "@/api/db/schema";
import { orgAIConfigStatusError } from "@/api/lib/ai-config-response";
import {
  ACCOUNT_ACCESS,
  authorizeHandlerRunSize,
  configuredModelAdmission,
  createSafeHandler,
} from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { encryptedContentError } from "@/api/lib/files/detect-file-encryption";
import { LIMITS } from "@/api/lib/limits";
import { WHOLE_DOCUMENT_SCOPE } from "@/api/lib/lists/verification/contract";
import type { VerificationScope } from "@/api/lib/lists/verification/contract";
import { readVerificationDocument } from "@/api/lib/lists/verification/document-text";
import { readVerificationEvidence } from "@/api/lib/lists/verification/evidence";
import { VERIFICATION_MODEL_TASK } from "@/api/lib/lists/verification/model-call";
import {
  passageBytes,
  resolveParagraphScope,
  scopePassages,
} from "@/api/lib/lists/verification/paragraph-scope";
import type { ParagraphScopeRefusal } from "@/api/lib/lists/verification/paragraph-scope";
import { enqueueListVerificationRun } from "@/api/lib/lists/verification/run-queue";
import { startVerificationRun } from "@/api/lib/lists/verification/start-run";
import { getTanStackTextModelInfoForTask } from "@/api/lib/tanstack-ai-models";
import {
  ModelRunCapError,
  modelRunCapRefusal,
} from "@/api/lib/usage/model-run-caps/caps";
import { estimateDocumentRunUnits } from "@/api/lib/usage/run-estimate";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const bodySchema = v.object({
  listId: resourceIdSchema("legalList"),
  entityId: resourceIdSchema("entity"),
  fileFieldId: resourceIdSchema("field"),
  paragraphs: v.optional(
    decisionParagraphRangeSchema(
      "Check only these paragraphs, e.g. `82-136` or `14`: the numbers the " +
        "document prints on its paragraphs, or their positions when it " +
        "numbers none. Omit to check the whole document.",
    ),
  ),
  confirmedUnits: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const config = {
  contract: "patch",
  // The run is queued here; its worker takes a background slot.
  actionAdmission: { type: "handler", actionKind: "list-verification.start" },
  description:
    "Start checking one document (DOCX, PDF, or a file with a PDF " +
    "rendition) against the facts of one list. Every claim the document " +
    "makes is found and, when factual, graded against the list's facts " +
    "(held facts are left out); with `paragraphs`, only the claims in that " +
    "range. Returns a run id; read the result with " +
    "lists.verifications.get. A document holds one unfinished verification " +
    "at a time.",
  permissions: { workspace: ["read"], entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  contentDelivery: {
    type: "none",
    reason:
      "Reads the document to find a paragraph range; returns a run id, never file bytes.",
  },
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: true,
  },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

/**
 * Claims expected per prompt byte, for sizing a run before its document is
 * read. A heuristic: one claim per ~100 tokens of prose.
 */
const PROMPT_BYTES_PER_EXPECTED_CLAIM = 400;
const PROMPT_BYTES_PER_STORED_BYTE = 4;

/** A run's size from the bytes it reads: the stored file, or a range's text. */
const estimateVerificationUnits = (modelId: string, inputBytes: number) =>
  estimateDocumentRunUnits({
    modelId,
    actionType: "doc_review",
    storedInputBytes: inputBytes,
    plannedOutputs: Math.ceil(
      (inputBytes * PROMPT_BYTES_PER_STORED_BYTE) /
        PROMPT_BYTES_PER_EXPECTED_CLAIM,
    ),
    serviceTier: "standard",
  });

const scopeAuditLabel = (scope: VerificationScope): string =>
  scope.kind === "whole"
    ? "whole"
    : `paragraphs ${String(scope.from)}-${String(scope.to)}`;

const requireVerifiableFile = (content: {
  mimeType: string;
  pdfFileId: string | null;
}): Result<void, HandlerError<422>> => {
  if (
    content.mimeType === DOCX_MIME_TYPE ||
    content.mimeType === PDF_MIME_TYPE ||
    content.pdfFileId !== null
  ) {
    return Result.ok(undefined);
  }
  return Result.err(
    new HandlerError({
      status: 422,
      message:
        "Only DOCX files, PDFs and files with a PDF rendition can be verified.",
    }),
  );
};

/** Long enough for the largest document a matter may hold to download. */
const SCOPE_READ_TIMEOUT_MS = 60_000;

const paragraphList = (numbers: readonly number[]): string =>
  numbers.map(String).join(" and ");

const scopeRefusalError = (
  refusal: ParagraphScopeRefusal,
): HandlerError<422> => {
  switch (refusal.type) {
    case "not-found": {
      const available =
        refusal.available === null
          ? "It has no paragraphs to count."
          : `Its paragraphs run from ${String(refusal.available.from)} to ${String(refusal.available.to)}.`;
      return new HandlerError({
        status: 422,
        code: VERIFICATION_SCOPE_REFUSALS.paragraphsNotFound,
        message: `Paragraph ${paragraphList(refusal.missing)} is not in this document.`,
        hint:
          refusal.numbering === "document"
            ? `${available} Use the numbers the document prints.`
            : `${available} This document does not number its paragraphs, so they are counted in order.`,
      });
    }
    case "empty": {
      return new HandlerError({
        status: 422,
        code: VERIFICATION_SCOPE_REFUSALS.paragraphsEmpty,
        message: "These paragraphs hold no text to check.",
        hint: "Choose a range that includes the paragraphs' text.",
      });
    }
    case "numbering-unclear": {
      return new HandlerError({
        status: 422,
        code: VERIFICATION_SCOPE_REFUSALS.numberingUnclear,
        message:
          "This document's paragraph numbers could not be read reliably, so a range cannot be checked.",
        hint: "Verify the whole document instead.",
      });
    }
    default: {
      refusal satisfies never;
      return panic(`Unhandled scope refusal: ${String(refusal)}`);
    }
  }
};

type ResolveRunScopeArgs = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  file: {
    id: string;
    mimeType: string;
    pdfFileId: string | null;
    sizeBytes: number;
  };
  paragraphs: ParagraphRange | undefined;
};

type RunScope = {
  scope: VerificationScope;
  /** What the run is sized by: the stored file, or the range's own text. */
  inputBytes: number;
};

/**
 * The scope a run starts with. A paragraph range is resolved against the
 * document now, so a range the document does not have is refused here and
 * a run never quietly checks the whole document instead.
 */
const resolveRunScope = async ({
  organizationId,
  workspaceId,
  file,
  paragraphs,
}: ResolveRunScopeArgs): Promise<
  Result<RunScope, HandlerError<422> | HandlerError<502>>
> => {
  if (paragraphs === undefined) {
    return Result.ok({
      scope: WHOLE_DOCUMENT_SCOPE,
      inputBytes: file.sizeBytes,
    });
  }
  const read = await Result.tryPromise({
    try: async () =>
      await readVerificationDocument({
        organizationId,
        workspaceId,
        file: {
          fileId: file.id,
          mimeType: file.mimeType,
          pdfFileId: file.pdfFileId,
          sizeBytes: file.sizeBytes,
        },
        signal: AbortSignal.timeout(SCOPE_READ_TIMEOUT_MS),
        admissionWaitMs: LIMITS.documentBytesAdmissionWaitMs,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 502,
        code: "upstream_unavailable",
        message: "The document could not be read to find these paragraphs.",
        hint: "Try again in a moment.",
        retryable: true,
        retryAfterMs: 1000,
        cause,
      }),
  });
  if (Result.isError(read)) {
    return Result.err(read.error);
  }
  const document = read.value;
  if (document.type === "unsupported-format") {
    return panic("A verifiable file always has a readable format");
  }
  if (document.type === "busy") {
    return Result.err(
      new HandlerError({
        status: 502,
        code: "upstream_unavailable",
        message: "The document could not be read to find these paragraphs.",
        hint: "Try again in a moment.",
        retryable: true,
        retryAfterMs: 1000,
      }),
    );
  }
  if (document.type === "no-text") {
    return Result.err(
      new HandlerError({
        status: 422,
        code: VERIFICATION_SCOPE_REFUSALS.noText,
        message: "No text could be read from this document.",
        hint: "Upload a version with a text layer, such as a PDF made from the original file.",
      }),
    );
  }
  const resolution = resolveParagraphScope(document.blocks, paragraphs);
  if (resolution.type !== "resolved") {
    return Result.err(scopeRefusalError(resolution));
  }
  const passages =
    scopePassages(document.blocks, resolution.scope) ??
    panic("A range resolved against these blocks must land in them");
  return Result.ok({
    scope: resolution.scope,
    inputBytes: passageBytes(passages),
  });
};

type MarkVerificationEnqueueFailedOptions = {
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"legalListVerificationRun">;
};

const markVerificationEnqueueFailed = async (
  options: MarkVerificationEnqueueFailedOptions,
) =>
  await options.safeDb(async (tx) => {
    await tx
      .update(legalListVerificationRuns)
      .set({
        status: "failed",
        errorCode: "enqueue_failed",
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(legalListVerificationRuns.id, options.runId),
          eq(legalListVerificationRuns.workspaceId, options.workspaceId),
        ),
      );
    await options.recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
      resourceId: options.runId,
      metadata: { status: "failed", errorCode: "enqueue_failed" },
    });
  });

const createVerification = createSafeHandler(
  config,
  async function* ({
    body,
    modelAdmission,
    orgAIConfig,
    orgAIConfigStatus,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const accessError = orgAIConfigStatusError(orgAIConfigStatus);
    if (accessError) {
      return Result.err(accessError);
    }
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
    const field = version?.fields.find(
      (candidate) => candidate.id === fileFieldId,
    );
    if (
      target.list === undefined ||
      version === undefined ||
      version === null ||
      field?.content.type !== "file"
    ) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "List or document not found",
        }),
      );
    }
    const file = field.content;
    if (file.encrypted) {
      return Result.err(encryptedContentError());
    }
    yield* requireVerifiableFile(file);
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
    const runScope = yield* Result.await(
      resolveRunScope({
        organizationId,
        workspaceId,
        file,
        paragraphs: body.paragraphs,
      }),
    );
    const model = getTanStackTextModelInfoForTask(
      VERIFICATION_MODEL_TASK,
      orgAIConfig,
      {
        dataClass: "customer",
        organizationId,
        modelTier: configuredModelAdmission({ modelAdmission }).modelTier,
      },
    );
    const authorization = yield* Result.await(
      authorizeHandlerRunSize({
        metering: {
          actionType: "doc_review",
          modelTask: VERIFICATION_MODEL_TASK,
        },
        estimatedUnits: estimateVerificationUnits(
          model.modelId,
          runScope.inputBytes,
        ),
        confirmedUnits: body.confirmedUnits,
        organizationId,
        orgAIConfig,
        workspaceId,
        userId: user.id,
        safeDb,
        recordAuditEvent,
        listId,
        entityId,
        fileFieldId,
        version,
        file,
        evidence: evidence.evidence,
        scope: runScope.scope,
      }),
    );
    return await authorization.execute(
      async ({ proof }) =>
        await Result.gen(async function* () {
          const checked = proof.input.value;
          const runId = createSafeId<"legalListVerificationRun">();
          const inserted = await startVerificationRun({
            safeDb: checked.safeDb,
            run: {
              id: runId,
              organizationId: checked.organizationId,
              workspaceId: checked.workspaceId,
              entityId: checked.entityId,
              fileFieldId: checked.fileFieldId,
              entityVersionId: checked.version.id,
              contentSha256: checked.file.sha256Hex,
              evidence: checked.evidence,
              scope: checked.scope,
              requestedBy: checked.userId,
            },
            recordAuditEvent: async (tx) =>
              await checked.recordAuditEvent(tx, {
                action: AUDIT_ACTION.EXECUTE,
                resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
                resourceId: runId,
                metadata: {
                  listId: checked.listId,
                  entityId: checked.entityId,
                  fileFieldId: checked.fileFieldId,
                  factCount: checked.evidence.facts.length,
                  scope: scopeAuditLabel(checked.scope),
                },
              }),
          });
          const created = yield* inserted.mapError((error) =>
            ModelRunCapError.is(error) ? modelRunCapRefusal(error) : error,
          );
          if (!created) {
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
                workspaceId: checked.workspaceId,
                organizationId: checked.organizationId,
                userId: checked.userId,
              }),
            catch: (cause) => cause,
          });
          if (Result.isError(enqueued)) {
            // A never-enqueued run must not hold the document's active slot.
            yield* Result.await(
              markVerificationEnqueueFailed({
                safeDb: checked.safeDb,
                recordAuditEvent: checked.recordAuditEvent,
                workspaceId: checked.workspaceId,
                runId,
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
        }),
    );
  },
);

export default createVerification;
