import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import {
  type DesktopDictationTranscriptAudioSaved,
  desktopDictationTranscriptAudioSavedSchema,
} from "@stll/api-contract/desktop-dictation-transcription";

import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  finalizeOwnPendingUpload,
  UPLOAD_NOT_FOUND_CODE,
} from "@/api/handlers/uploads/update";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  authorizeDesktopTranscriptSave,
  type DesktopTranscriptAccount,
  readDesktopTranscriptMatter,
} from "@/api/lib/dictation/desktop-transcript-access";
import {
  authorizeDocumentWriteAccess,
  documentWriteRefusalHandlerError,
} from "@/api/lib/entities/authorize-document-write";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { broadcastWorkspaceResourceUpdated } from "@/api/lib/resource-realtime";

/** The recording a desktop uploaded into a transcript's folder. */
const desktopDictationTranscriptAudioBodySchema = v.strictObject({
  matterId: resourceIdSchema("workspace"),
  uploadId: resourceIdSchema("pendingUpload"),
});

type AudioBody = v.InferOutput<
  typeof desktopDictationTranscriptAudioBodySchema
>;

/** Finalizes the member's own recording upload: only a new document, the
 *  one purpose the transcript route reserves. */
const finalizeAudioUpload = async ({
  account,
  request,
  matterId,
  uploadId,
}: AudioBody & { account: DesktopTranscriptAccount; request: Request }) =>
  await Result.gen(async function* () {
    const finalized = yield* finalizeOwnPendingUpload({
      safeDb: safeDbFromScoped(account.scopedDb),
      organizationId: account.organizationId,
      workspaceId: matterId,
      userId: account.userId,
      memberRole: account.memberRole,
      uploadId,
      recordAuditEvent: createAuditRecorder({
        organizationId: account.organizationId,
        userId: account.userId,
        workspaceId: matterId,
        request,
        server: null,
      }),
      authorizeConsent: (purpose) =>
        purpose === "entity_create"
          ? Result.ok(undefined)
          : Result.err(
              new HandlerError({
                code: UPLOAD_NOT_FOUND_CODE,
                status: 404,
                message: "Upload not found",
              }),
            ),
    });
    if (Result.isError(finalized)) {
      return Result.err(finalized.error);
    }
    const result = finalized.value.finalizedResult;
    if (result.type !== "entity_create") {
      return unreachable("A recording upload always creates a document");
    }
    broadcastWorkspaceResourceUpdated(
      matterId,
      resourceRef({ type: RESOURCE_TYPE.ENTITY, id: result.entityId }),
    );
    return Result.ok({ fileName: result.fileName });
  });

/**
 * A linked desktop finalizes the recording it uploaded into a transcript's
 * folder: the stored bytes are checked against the size and checksum it
 * declared, scanned, and filed as a document in the folder. Finalizing
 * again answers with the same document. It needs what filing the
 * transcript needs: the dictation decision, a matter the member sees and
 * document create permission in it, and the upload must be the member's.
 */
export const createDesktopDictationTranscriptAudioEndpoint = ({
  authorizeAccount = authorizeDesktopAccount,
  readMatter = readDesktopTranscriptMatter,
  finalizeAudio = finalizeAudioUpload,
}: {
  authorizeAccount?: typeof authorizeDesktopAccount;
  readMatter?: typeof readDesktopTranscriptMatter;
  finalizeAudio?: typeof finalizeAudioUpload;
} = {}) =>
  createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "auth_plumbing" },
      cache: { kind: "none" },
      body: desktopDictationTranscriptAudioBodySchema,
      response: safePublicHandlerResponseSchemasWithStatusText(
        desktopDictationTranscriptAudioSavedSchema,
      ),
      aggregateMutation: {
        type: "independent",
        reason:
          "Finalizes one upload the member reserved through the shared upload finalize, which claims the upload row and takes its own workspace and entity locks.",
      },
    },
    async function* ({ request, body }) {
      const account = yield* Result.await(
        authorizeDesktopTranscriptSave(request, authorizeAccount),
      );
      const workspace = yield* Result.await(readMatter(account, body.matterId));
      const access = authorizeDocumentWriteAccess({
        authority: account.memberRole,
        workspace,
        operation: { type: "create", workspaceId: body.matterId },
      });
      if (Result.isError(access)) {
        return Result.err(documentWriteRefusalHandlerError(access.error));
      }
      const saved = yield* Result.await(
        finalizeAudio({
          account,
          request,
          matterId: access.value.operation.workspaceId,
          uploadId: body.uploadId,
        }),
      );
      return Result.ok({
        fileName: saved.fileName,
      } satisfies DesktopDictationTranscriptAudioSaved);
    },
  );

export const saveDesktopDictationTranscriptAudio =
  createDesktopDictationTranscriptAudioEndpoint();
