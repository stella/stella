/**
 * Start extracting facts from a matter's evidence documents into one list.
 * The documents' current versions are pinned when the run starts; the
 * reading runs in the background, and the facts arrive as generation
 * candidates a person accepts or rejects (lists.generation-candidates.*).
 */

import { panic, Result } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  fields,
  legalListGenerationRuns,
  legalListGenerationSources,
} from "@/api/db/schema";
import { legalListRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
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
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { readBounded } from "@/api/lib/db/read-bounded";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { LIST_OR_DOCUMENT_NOT_FOUND } from "@/api/lib/lists/fact-tiers";
import { failGenerationRun } from "@/api/lib/lists/generation/run-persistence";
import { enqueueFactExtractionRun } from "@/api/lib/lists/generation/run-queue";
import { VERIFICATION_MODEL_TASK } from "@/api/lib/lists/verification/model-call";
import {
  getVerificationRunCaps,
  verificationCapErrorFromDatabase,
} from "@/api/lib/lists/verification/run-caps";
import { findExtractionFileFieldRow } from "@/api/lib/search/types";
import { getTanStackTextModelInfoForTask } from "@/api/lib/tanstack-ai-models";
import { estimateDocumentRunUnits } from "@/api/lib/usage/run-estimate";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

/** Documents one run reads; each is read in full. */
const FACT_EXTRACTION_DOCUMENTS_MAX = 25;

/** Fields read per document version when choosing its file. */
const VERSION_FIELDS_READ_MAX = 200;

const DEFAULT_INSTRUCTION = "List every fact the documents establish.";

const bodySchema = v.object({
  listId: resourceIdSchema("legalList"),
  entityIds: v.pipe(
    v.array(resourceIdSchema("entity")),
    v.minLength(1),
    v.maxLength(FACT_EXTRACTION_DOCUMENTS_MAX),
  ),
  instruction: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
  ),
  confirmedUnits: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const config = {
  contract: "patch",
  idempotency: { type: "replay" },
  // The run is queued here; its worker takes a background slot.
  actionAdmission: {
    type: "handler",
    actionKind: "list-fact-extraction.start",
  },
  description:
    "Start reading the facts out of evidence documents (DOCX, PDF, or files " +
    "with a PDF rendition) into one list. Each document's current version " +
    "is pinned. Every fact cites the passage it comes from, carries when it " +
    "happened, whether it rests on a document or on testimony, and how " +
    "unambiguous its meaning is; a fact whose meaning is genuinely contested " +
    "is held with a note. An optional instruction says which facts matter. " +
    "Returns a generation run id; poll lists.generations.list for its status " +
    "and read the proposed facts with lists.generation-candidates.list, then " +
    "accept or reject each.",
  permissions: { workspace: ["read"], entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  featureAccess: { featureId: LIST_VERIFICATION_FEATURE_ID, type: "required" },
  realtime: legalListRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: true,
  },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

/** Facts expected per prompt byte, for sizing a run before it reads. */
const PROMPT_BYTES_PER_EXPECTED_FACT = 400;
const PROMPT_BYTES_PER_STORED_BYTE = 4;

const isReadableFile = (content: {
  mimeType: string;
  pdfFileId: string | null;
}) =>
  content.mimeType === DOCX_MIME_TYPE ||
  content.mimeType === PDF_MIME_TYPE ||
  content.pdfFileId !== null;

type PinnedDocument = {
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
  sizeBytes: number;
};

type ReadTargetsResult =
  | { type: "found"; documents: PinnedDocument[] }
  | { type: "missing" }
  | { type: "unreadable" }
  | { type: "encrypted" };

const readTargets = async (
  tx: Transaction,
  workspaceId: SafeId<"workspace">,
  listId: SafeId<"legalList">,
  entityIds: readonly SafeId<"entity">[],
): Promise<ReadTargetsResult> => {
  const list = await tx.query.legalLists.findFirst({
    where: {
      id: { eq: listId },
      workspaceId: { eq: workspaceId },
      status: { eq: "active" },
    },
    columns: { id: true },
  });
  const documents = await tx
    .select({ id: entities.id, versionId: entities.currentVersionId })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.kind, "document"),
        inArray(entities.id, [...entityIds]),
      ),
    );
  if (list === undefined || documents.length !== entityIds.length) {
    return { type: "missing" };
  }
  const versionIds = documents.flatMap((document) =>
    document.versionId === null ? [] : [document.versionId],
  );
  if (versionIds.length !== documents.length) {
    return { type: "missing" };
  }
  const versionFieldRead = await readBounded(
    tx
      .select({
        id: fields.id,
        entityVersionId: fields.entityVersionId,
        content: fields.content,
      })
      .from(fields)
      .where(
        and(
          eq(fields.workspaceId, workspaceId),
          inArray(fields.entityVersionId, versionIds),
        ),
      )
      // Ascending id is creation order, which the file choice needs.
      .orderBy(asc(fields.id)),
    FACT_EXTRACTION_DOCUMENTS_MAX * VERSION_FIELDS_READ_MAX,
  );
  // More fields than any document carries: nothing to choose a file from.
  if (versionFieldRead.type === "overflow") {
    return { type: "unreadable" };
  }
  const versionFields = versionFieldRead.rows;
  const byId = new Map(documents.map((document) => [document.id, document]));
  const pinned: PinnedDocument[] = [];
  // In the order the caller named them: the order facts are proposed in.
  for (const entityId of entityIds) {
    const versionId = byId.get(entityId)?.versionId ?? null;
    const field =
      versionId === null
        ? null
        : findExtractionFileFieldRow(
            versionFields.filter(
              (candidate) => candidate.entityVersionId === versionId,
            ),
          );
    if (versionId === null || field === null) {
      return { type: "missing" };
    }
    if (field.content.encrypted) {
      return { type: "encrypted" };
    }
    if (!isReadableFile(field.content)) {
      return { type: "unreadable" };
    }
    pinned.push({ entityId, versionId, sizeBytes: field.content.sizeBytes });
  }
  return { type: "found", documents: pinned };
};

type StartRunArgs = {
  safeDb: SafeDb;
  recordAuditEvent: AuditRecorder;
  run: {
    id: SafeId<"legalListGenerationRun">;
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace">;
    listId: SafeId<"legalList">;
    instruction: string;
    requestedBy: SafeId<"user">;
  };
  documents: readonly PinnedDocument[];
};

/**
 * Insert the queued run and its pinned sources. The run counts against the
 * organization's list AI run budget, shared with verifications: the insert
 * trigger charges it and refuses a run over either cap, rolling back both.
 */
const startRun = async ({
  safeDb,
  recordAuditEvent,
  run,
  documents,
}: StartRunArgs) => {
  const caps = getVerificationRunCaps();
  const inserted = await safeDb(async (tx) => {
    await tx.execute(sql`SELECT
      set_config('app.list_verification_active_limit', ${String(caps.active)}, true),
      set_config('app.list_verification_daily_limit', ${String(caps.startsPerDay)}, true)`);
    await tx.insert(legalListGenerationRuns).values({
      ...run,
      status: "queued",
      producer: "stella",
      itemType: LIST_ITEM_TYPE.FACT,
    });
    await tx.insert(legalListGenerationSources).values(
      documents.map((document) => ({
        id: createSafeId<"legalListGenerationSource">(),
        workspaceId: run.workspaceId,
        listId: run.listId,
        runId: run.id,
        sourceEntityId: document.entityId,
        sourceEntityVersionId: document.versionId,
      })),
    );
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.EXECUTE,
      resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
      resourceId: run.id,
      metadata: {
        operation: "fact_extraction_started",
        listId: run.listId,
        sourceCount: documents.length,
      },
    });
  });
  return inserted.mapError((error) => {
    const cap = verificationCapErrorFromDatabase(error);
    return cap === null
      ? error
      : new HandlerError({
          status: 429,
          code: cap.code,
          message:
            cap.reason === "active"
              ? "This organization has reached its limit of list AI runs in progress (fact extractions and verifications)."
              : "This organization has reached its daily limit of list AI runs (fact extractions and verifications).",
          hint:
            cap.reason === "active"
              ? "Wait for a fact extraction or verification to finish, then retry lists.fact-extractions.create."
              : "Retry lists.fact-extractions.create after midnight in Europe/Prague.",
          retryable: true,
        });
  });
};

const createFactExtraction = createSafeHandler(
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
    const entityIds = [...new Set(body.entityIds)];
    if (entityIds.length !== body.entityIds.length) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "duplicate_document",
          message: "Name each document once.",
        }),
      );
    }
    const targets = yield* Result.await(
      safeDb(
        async (tx) =>
          await readTargets(tx, workspaceId, body.listId, entityIds),
      ),
    );
    switch (targets.type) {
      case "missing": {
        return Result.err(
          new HandlerError({
            status: 404,
            code: LIST_OR_DOCUMENT_NOT_FOUND,
            message: "List or document not found",
          }),
        );
      }
      case "encrypted": {
        return Result.err(
          new HandlerError({
            status: 422,
            code: "document_encrypted",
            message:
              "An encrypted document cannot be read; remove its password and upload it again.",
          }),
        );
      }
      case "unreadable": {
        return Result.err(
          new HandlerError({
            status: 422,
            code: "document_format_unsupported",
            message:
              "Only DOCX files, PDFs and files with a PDF rendition can be read for facts.",
          }),
        );
      }
      case "found": {
        break;
      }
      default: {
        targets satisfies never;
        return panic(`Unhandled fact extraction target: ${String(targets)}`);
      }
    }
    const documents = targets.documents;
    const storedInputBytes = documents.reduce(
      (total, document) => total + document.sizeBytes,
      0,
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
        // Every document is read in full, so the run is sized by all of them.
        estimatedUnits: estimateDocumentRunUnits({
          modelId: model.modelId,
          actionType: "doc_review",
          storedInputBytes,
          plannedOutputs: Math.ceil(
            (storedInputBytes * PROMPT_BYTES_PER_STORED_BYTE) /
              PROMPT_BYTES_PER_EXPECTED_FACT,
          ),
          serviceTier: "standard",
        }),
        confirmedUnits: body.confirmedUnits,
        organizationId,
        orgAIConfig,
        workspaceId,
        userId: user.id,
        safeDb,
        recordAuditEvent,
        listId: body.listId,
        instruction: body.instruction ?? DEFAULT_INSTRUCTION,
        documents,
      }),
    );
    return await authorization.execute(
      async ({ proof }) =>
        await Result.gen(async function* () {
          const checked = proof.input.value;
          const runId = createSafeId<"legalListGenerationRun">();
          yield* Result.await(
            startRun({
              safeDb: checked.safeDb,
              recordAuditEvent: checked.recordAuditEvent,
              run: {
                id: runId,
                organizationId: checked.organizationId,
                workspaceId: checked.workspaceId,
                listId: checked.listId,
                instruction: checked.instruction,
                requestedBy: checked.userId,
              },
              documents: checked.documents,
            }),
          );

          const enqueued = await Result.tryPromise({
            try: async () =>
              await enqueueFactExtractionRun({
                runId,
                workspaceId: checked.workspaceId,
                organizationId: checked.organizationId,
                userId: checked.userId,
              }),
            catch: (cause) => cause,
          });
          if (Result.isError(enqueued)) {
            // A never-enqueued run must not hold an active slot.
            yield* Result.await(
              checked.safeDb(
                async (tx) =>
                  await failGenerationRun({
                    tx,
                    run: {
                      id: runId,
                      workspaceId: checked.workspaceId,
                      organizationId: checked.organizationId,
                    },
                    errorCode: "enqueue_failed",
                    expectedStatus: "queued",
                  }),
              ),
            );
            return Result.err(
              new HandlerError({
                status: 500,
                code: "fact_extraction_enqueue_failed",
                message: "The fact extraction could not be started.",
                cause: enqueued.error,
              }),
            );
          }

          return Result.ok({ runId, status: "queued" as const });
        }),
    );
  },
);

declareAggregateMutation(createFactExtraction, {
  type: "independent",
  reason:
    "Inserts a new queued run and its pinned sources in one transaction; the organization run budget serializes concurrent starts on its counter row.",
});

export default createFactExtraction;
