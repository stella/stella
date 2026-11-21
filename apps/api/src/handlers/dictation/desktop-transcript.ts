import { Result } from "better-result";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_TRANSCRIPT_LIMITS,
  type DesktopDictationTranscriptAudioOutcome,
  desktopDictationTranscriptAudioSchema,
  desktopDictationTranscriptCleanedSchema,
  desktopDictationTranscriptFolderSchema,
  desktopDictationTranscriptParagraphsSchema,
  type DesktopDictationTranscriptSaved,
  desktopDictationTranscriptSavedSchema,
  MAX_DESKTOP_DICTATION_TRANSCRIPT_AUDIO_BYTES,
} from "@stll/api-contract/desktop-dictation-transcription";
import {
  cleanedTranscriptDocx,
  transcriptDocx,
} from "@stll/docx-authoring/transcript";
import { classifyFailure } from "@stll/errors";

import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import {
  authorizeDesktopTranscriptSave,
  type DesktopTranscriptAccount,
  readDesktopTranscriptMatter,
} from "@/api/lib/dictation/desktop-transcript-access";
import {
  authorizeDocumentWriteAccess,
  documentWriteRefusalHandlerError,
  DocumentWriteRefusedError,
} from "@/api/lib/entities/authorize-document-write";
import { CALLER_AUTHORIZED } from "@/api/lib/entities/buffer-write-authority";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "@/api/lib/files/organization-file-usage";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { reservePresignedUpload } from "@/api/lib/uploads/reserve-presigned-upload";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

import { createTranscriptFolder } from "./transcript-folder";

/** The transcript a desktop files: the matter, a title (the recording's
 *  name) and its paragraphs. A desktop that names the documents in
 *  `folder` files them in a folder named after the recording, with the
 *  cleaned-up text and the recording when it sends them. A desktop released
 *  before folders sends no `folder` and files the transcript alone at the
 *  matter's root; `folder` becomes required once no supported desktop
 *  sends that shape. Unknown fields are refused, never dropped. */
const desktopDictationTranscriptBodySchema = v.strictObject({
  matterId: resourceIdSchema("workspace"),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(DESKTOP_DICTATION_TRANSCRIPT_LIMITS.titleLength),
  ),
  paragraphs: desktopDictationTranscriptParagraphsSchema,
  folder: v.optional(desktopDictationTranscriptFolderSchema),
  cleaned: v.optional(desktopDictationTranscriptCleanedSchema),
  audio: v.optional(desktopDictationTranscriptAudioSchema),
});

type TranscriptBody = v.InferOutput<
  typeof desktopDictationTranscriptBodySchema
>;

const documentLayoutError = (message: string) => (cause: unknown) =>
  // The renderer's own tagged error says what failed.
  classifyFailure(
    new HandlerError({ status: 500, message, cause }),
    "tagged_failure",
  );

const renderedTranscript = async (
  body: Pick<TranscriptBody, "title" | "paragraphs">,
): Promise<Result<ArrayBuffer, HandlerError>> =>
  Result.mapError(
    await transcriptDocx(body),
    documentLayoutError("The transcript could not be laid out as a document"),
  );

type ReserveAudioInput = {
  account: DesktopTranscriptAccount;
  matterId: TranscriptBody["matterId"];
  folderId: SafeId<"entity">;
  audio: NonNullable<TranscriptBody["audio"]>;
};

/** Reserves the recording's upload into the folder: a new document under
 *  the matter's file column, signed against its size and checksum. The
 *  caller has authorized the member to create documents in the matter. */
const reserveAudioUpload = async ({
  account,
  matterId,
  folderId,
  audio,
}: ReserveAudioInput) =>
  await Result.gen(async function* () {
    const safeDb = safeDbFromScoped(account.scopedDb);
    const properties = yield* Result.await(
      safeDb(
        async (tx) =>
          await tx.query.properties.findMany({
            columns: { id: true, content: true },
            where: { workspaceId: { eq: matterId } },
            limit: LIMITS.propertiesCount,
          }),
      ),
    );
    const fileProperty = properties.find(
      (property) => property.content.type === "file",
    );
    if (fileProperty === undefined) {
      return Result.err(missingFilePropertyError());
    }
    return yield* reservePresignedUpload({
      safeDb,
      organizationId: account.organizationId,
      workspaceId: matterId,
      userId: account.userId,
      purposeData: {
        type: "entity_create",
        propertyId: fileProperty.id,
        parentId: folderId,
      },
      file: audio,
    });
  });

const cleanedFilingFailure = failureSink({
  event: "desktop_transcript.cleaned_filing_failed",
  expected: [],
});

const audioReservationFailure = failureSink({
  event: "desktop_transcript.audio_reservation_failed",
  expected: [],
});

/** Whether a declared recording is small enough to become a matter
 *  document; a larger one is left out and takes no place in the matter. */
const fitsMatterDocument = (audio: NonNullable<TranscriptBody["audio"]>) =>
  audio.size <= MAX_DESKTOP_DICTATION_TRANSCRIPT_AUDIO_BYTES;

/** What becomes of the recording the desktop declared: an upload into the
 *  folder, or why it is left out. The documents are filed either way. */
const audioOutcome = async (
  input: ReserveAudioInput,
  reserveAudio: typeof reserveAudioUpload,
): Promise<DesktopDictationTranscriptAudioOutcome> => {
  if (!fitsMatterDocument(input.audio)) {
    return {
      status: "too_large",
      maxBytes: MAX_DESKTOP_DICTATION_TRANSCRIPT_AUDIO_BYTES,
    };
  }
  const reserved = await reserveAudio(input);
  if (Result.isError(reserved)) {
    // The documents are filed; the desktop shows the recording as not
    // saved, and the cause is recorded here.
    observeFailure(reserved.error, { sink: audioReservationFailure });
    return {
      status: "refused",
      message: HandlerError.is(reserved.error)
        ? reserved.error.message
        : "The recording could not be prepared for upload.",
    };
  }
  return {
    status: "upload",
    uploadId: reserved.value.uploadId,
    url: reserved.value.url,
    expiresAt: reserved.value.expiresAt,
    headers: { ...reserved.value.headers },
  };
};

/**
 * A linked desktop files a recording's transcript in a matter: a Word
 * document in stella's house style, named after the recording. An older
 * desktop files it at the matter's root. A desktop that sends `folder`
 * files it in a new folder at the root named after the recording, with
 * the cleaned-up text as a second Word document when it has one, and gets
 * a presigned upload for the recording it declared, which it finalizes at
 * the audio route. The member must see the matter and may create
 * documents in it; the text is the member's own, sent once and stored
 * only as the documents.
 */
export const createDesktopDictationTranscriptEndpoint = ({
  authorizeAccount = authorizeDesktopAccount,
  readMatter = readDesktopTranscriptMatter,
  createEntity = createEntityFromBuffer,
  createFolder = createTranscriptFolder,
  reserveAudio = reserveAudioUpload,
}: {
  authorizeAccount?: typeof authorizeDesktopAccount;
  readMatter?: typeof readDesktopTranscriptMatter;
  createEntity?: typeof createEntityFromBuffer;
  createFolder?: typeof createTranscriptFolder;
  reserveAudio?: typeof reserveAudioUpload;
} = {}) =>
  declareAggregateMutation(
    createSafeBoundedPublicHandler(
      {
        contract: "patch",
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "auth_plumbing" },
        cache: { kind: "none" },
        body: desktopDictationTranscriptBodySchema,
        response: safePublicHandlerResponseSchemasWithStatusText(
          desktopDictationTranscriptSavedSchema,
        ),
      },
      async function* ({ request, body }) {
        if (
          body.folder === undefined &&
          (body.cleaned !== undefined || body.audio !== undefined)
        ) {
          return Result.err(
            new HandlerError({
              code: "transcript_folder_required",
              status: 422,
              message:
                "Cleaned-up text and a recording are filed only in a folder",
            }),
          );
        }
        const account = yield* Result.await(
          authorizeDesktopTranscriptSave(request, authorizeAccount),
        );
        const workspace = yield* Result.await(
          readMatter(account, body.matterId),
        );
        const access = authorizeDocumentWriteAccess({
          authority: account.memberRole,
          workspace,
          operation: { type: "create", workspaceId: body.matterId },
        });
        if (Result.isError(access)) {
          return Result.err(documentWriteRefusalHandlerError(access.error));
        }
        const workspaceId = access.value.operation.workspaceId;
        const recordAuditEvent = createAuditRecorder({
          organizationId: account.organizationId,
          userId: account.userId,
          workspaceId: body.matterId,
          request,
          server: null,
        });
        const fileDocument = async ({
          buffer,
          name,
          parentId,
        }: {
          buffer: ArrayBuffer;
          name: string;
          parentId: SafeId<"entity"> | null;
        }) =>
          await createEntity({
            // The request authorized the member's create access above.
            authority: CALLER_AUTHORIZED,
            scopedDb: account.scopedDb,
            organizationId: account.organizationId,
            workspaceId,
            userId: account.userId,
            recordAuditEvent,
            buffer,
            fileName: sanitizeFilenamePreservingExtension(`${name}.docx`),
            mimeType: DOCX_MIME_TYPE,
            encryption: serverBuiltFileEncryption(),
            parentId,
          }).then((result) => Result.mapError(result, toHandlerError));

        const transcript = yield* Result.await(renderedTranscript(body));
        const { folder } = body;
        if (folder === undefined) {
          const created = yield* Result.await(
            fileDocument({
              buffer: transcript,
              name: body.title,
              parentId: null,
            }),
          );
          return Result.ok({
            fileName: created.fileName,
          } satisfies DesktopDictationTranscriptSaved);
        }

        // Every document is laid out before the folder exists, so a text
        // that cannot be rendered leaves nothing behind.
        const cleaned =
          body.cleaned === undefined
            ? null
            : yield* Result.await(
                cleanedTranscriptDocx({
                  markdown: body.cleaned.markdown,
                  instructions: body.cleaned.instructions,
                  instructionsLabel: folder.instructionsLabel,
                }).then((result) =>
                  Result.mapError(
                    result,
                    documentLayoutError(
                      "The cleaned-up text could not be laid out as a document",
                    ),
                  ),
                ),
              );
        const created = yield* Result.await(
          createFolder({
            scopedDb: account.scopedDb,
            workspaceId,
            userId: account.userId,
            title: body.title,
            // The folder and the transcript, then the cleaned-up text and a
            // recording that will be uploaded; one left out takes no place.
            entityCount:
              2 +
              (cleaned === null ? 0 : 1) +
              (body.audio !== undefined && fitsMatterDocument(body.audio)
                ? 1
                : 0),
            recordAuditEvent,
          }),
        );
        // A transcript that cannot be filed fails the save and leaves only
        // the empty folder, so a retry files it once, in a new folder.
        const filedTranscript = yield* Result.await(
          fileDocument({
            buffer: transcript,
            name: folder.transcriptName,
            parentId: created.folderId,
          }),
        );
        const files: NonNullable<DesktopDictationTranscriptSaved["files"]> = [
          { kind: "transcript", fileName: filedTranscript.fileName },
        ];
        const notFiled: NonNullable<
          DesktopDictationTranscriptSaved["notFiled"]
        > = [];
        if (cleaned !== null) {
          // Once the transcript is filed the save succeeds: the reply says
          // what the folder holds and what was left out, so the desktop
          // never files the transcript twice by retrying the whole save.
          // A create that rejects instead of answering is left out the
          // same way as one that refuses.
          const attempted = await Result.tryPromise({
            try: async () =>
              await fileDocument({
                buffer: cleaned,
                name: folder.cleanedName,
                parentId: created.folderId,
              }),
            catch: (cause: unknown) => cause,
          });
          const filedCleaned = Result.isError(attempted)
            ? attempted
            : attempted.value;
          if (Result.isOk(filedCleaned)) {
            files.push({
              kind: "cleaned",
              fileName: filedCleaned.value.fileName,
            });
          } else {
            const failure: unknown = filedCleaned.error;
            observeFailure(failure, { sink: cleanedFilingFailure });
            notFiled.push({
              kind: "cleaned",
              message: HandlerError.is(failure)
                ? failure.message
                : "The cleaned-up text could not be filed.",
            });
          }
        }
        const audio =
          body.audio === undefined
            ? undefined
            : await audioOutcome(
                {
                  account,
                  matterId: workspaceId,
                  folderId: created.folderId,
                  audio: body.audio,
                },
                reserveAudio,
              );
        return Result.ok({
          fileName: filedTranscript.fileName,
          folderName: created.folderName,
          files,
          ...(notFiled.length === 0 ? {} : { notFiled }),
          ...(audio === undefined ? {} : { audio }),
        } satisfies DesktopDictationTranscriptSaved);
      },
    ),
    {
      type: "independent",
      reason:
        "Creates a folder and documents in an authorized matter through the shared folder and document creates, which take their own workspace and entity locks, and reserves one upload through the shared presign.",
    },
  );

const missingFilePropertyError = () =>
  new HandlerError({
    code: "transcript_matter_file_property_missing",
    status: 422,
    message: "This matter has no file column to hold the transcript.",
  });

const toHandlerError = (
  error:
    | { _tag: "DocumentTooLargeError" }
    | { _tag: "EntityLimitError" }
    | { _tag: "InvalidParentError" }
    | { _tag: "MissingFilePropertyError" }
    | DocumentWriteRefusedError
    | OrganizationFileUsageError,
): HandlerError => {
  if (error instanceof OrganizationFileUsageError) {
    return organizationFileUsageHandlerError(error);
  }
  if (DocumentWriteRefusedError.is(error)) {
    return documentWriteRefusalHandlerError(error);
  }
  switch (error._tag) {
    case "DocumentTooLargeError":
      return new HandlerError({
        code: "transcript_document_too_large",
        status: 413,
        message: "The transcript is larger than a document may be.",
      });
    case "EntityLimitError":
      return new HandlerError({
        code: "transcript_matter_entity_limit_reached",
        status: 409,
        message: "This matter has reached its document limit.",
      });
    case "MissingFilePropertyError":
      return missingFilePropertyError();
    case "InvalidParentError":
      return new HandlerError({
        code: "transcript_folder_removed",
        status: 409,
        message: "The transcript's folder was removed while it was filed.",
      });
    default:
      return unreachable("Unhandled createEntityFromBuffer error tag");
  }
};

export const saveDesktopDictationTranscript =
  createDesktopDictationTranscriptEndpoint();
