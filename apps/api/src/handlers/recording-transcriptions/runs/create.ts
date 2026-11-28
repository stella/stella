import { Result } from "better-result";
import * as v from "valibot";

import { documentFormat } from "@stll/api-contract/document-format";

import { recordingTranscriptionRuns } from "@/api/db/schema";
import { memberAIAccessError } from "@/api/lib/ai-config-response";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { resolveEntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { handoffCommittedRecordingTranscriptionRun } from "@/api/lib/recording-transcription/handoff";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  // The run is queued here; its worker takes a background slot.
  actionAdmission: {
    type: "handler",
    actionKind: "recording-transcription.start",
  },
  contentDelivery: {
    type: "none",
    reason: "Queues a transcription without returning stored-file bytes.",
  },
  description:
    "Start a background transcription of a recording in the matter and save the transcript as a new document beside it.",
  permissions: { entity: ["create"], chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  access: "write",
  idempotency: { type: "replay" },
  realtime: noResourceSetUpdates(
    "Queues a run only; the transcript document is announced when the worker creates it.",
  ),
  mcp: {
    type: "capability",
    reason: "document_processing",
    consumesServices: true,
  },
  params: workspaceParams({}),
  body: v.strictObject({
    entityId: resourceIdSchema("entity"),
    fieldId: resourceIdSchema("field"),
  }),
  aggregateMutation: {
    type: "independent",
    reason:
      "Queues a transcription run; the transcript document is created later by the worker through the audited entity creation path.",
  },
} satisfies WorkspaceHandlerConfig;

const createRecordingTranscriptionRun = createSafeHandler(
  config,
  async function* ({
    body,
    orgAIConfigStatus,
    recordAuditEvent,
    safeDb,
    session,
    user,
    workspaceId,
  }) {
    const accessError = memberAIAccessError(orgAIConfigStatus);
    if (accessError) {
      return Result.err(accessError);
    }
    // The transcript is a new document, so a read-only recording is fine.
    const source = yield* Result.await(
      resolveEntityVersionFile({
        safeDb,
        workspaceId,
        entityId: body.entityId,
        fileFieldId: body.fieldId,
        allowReadOnly: true,
      }),
    );
    if (documentFormat(source.mimeType, source.fileName).kind !== "audio") {
      return Result.err(
        new HandlerError({
          status: 422,
          code: "recording_unsupported",
          message: "Only a recording can be transcribed",
        }),
      );
    }
    const runId = createSafeId<"recordingTranscriptionRun">();
    const organizationId = session.activeOrganizationId;
    const inserted = yield* Result.await(
      safeDb(async (tx) => {
        const created = await tx
          .insert(recordingTranscriptionRuns)
          .values({
            id: runId,
            organizationId,
            workspaceId,
            entityId: body.entityId,
            fileFieldId: body.fieldId,
            entityVersionId: source.entityVersionId,
            sourceFileId: source.fileId,
            sourceFileName: source.fileName,
            sourceMimeType: source.mimeType,
            requestedBy: user.id,
          })
          .onConflictDoNothing()
          .returning({ id: recordingTranscriptionRuns.id });
        if (!created.at(0)) {
          return false;
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: body.entityId,
          metadata: { operation: "recording.transcribe", runId },
        });
        return true;
      }),
    );
    if (!inserted) {
      return Result.err(
        new HandlerError({
          status: 409,
          code: "recording_transcription_in_progress",
          message: "This recording is already being transcribed",
        }),
      );
    }
    await handoffCommittedRecordingTranscriptionRun({
      runId,
      organizationId,
      workspaceId,
      userId: user.id,
    });
    return Result.ok({ runId });
  },
);

export default createRecordingTranscriptionRun;
