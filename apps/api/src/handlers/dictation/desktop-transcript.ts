import { Result } from "better-result";
import type { InferOk } from "better-result";
import * as v from "valibot";

import {
  DESKTOP_DICTATION_TRANSCRIPT_LIMITS,
  desktopDictationTranscriptParagraphsSchema,
  type DesktopDictationTranscriptSaved,
  desktopDictationTranscriptSavedSchema,
} from "@stll/api-contract/desktop-dictation-transcription";
import type { DesktopFeatureId } from "@stll/api-contract/desktop-feature-access";
import { classifyFailure } from "@stll/errors";

import { safeDbFromScoped } from "@/api/db/safe-db";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { authorizeDesktopAccount } from "@/api/lib/business-registries/desktop/auth";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { markdownToStellaDocx } from "@/api/lib/docx-authoring/from-markdown";
import {
  authorizeDocumentWriteAccess,
  documentWriteRefusalHandlerError,
  DocumentWriteRefusedError,
} from "@/api/lib/entities/authorize-document-write";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "@/api/lib/files/organization-file-usage";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

// Filing a transcript belongs with dictation on the desktop: it is what the
// member transcribed there, on this computer or with stella AI.
const REQUIRED_FEATURE_ID = "desktop-dictation" satisfies DesktopFeatureId;

type DesktopAccount = InferOk<
  Awaited<ReturnType<typeof authorizeDesktopAccount>>
>;

/** The transcript a desktop files: the matter, a title (the recording's
 *  name) and its paragraphs. Unknown fields are refused, never dropped. */
const desktopDictationTranscriptBodySchema = v.strictObject({
  matterId: resourceIdSchema("workspace"),
  title: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(DESKTOP_DICTATION_TRANSCRIPT_LIMITS.titleLength),
  ),
  paragraphs: desktopDictationTranscriptParagraphsSchema,
});

type TranscriptBody = v.InferOutput<
  typeof desktopDictationTranscriptBodySchema
>;

/** `m:ss`, or `h:mm:ss` from an hour on, as the desktop shows it. */
export const transcriptTimestamp = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${minutes}:${twoDigits(seconds)}`;
};

/**
 * Spoken words as literal Markdown text, escaped the way the document
 * renderer reads escapes back: emphasis, code, link and strike markers
 * always, an underscore outside a word, and an angle bracket that would
 * open a tag. The text stays on one line.
 */
export const markdownText = (text: string): string =>
  text
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/[\\`*[\]~]/gu, "\\$&")
    .replaceAll(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\_")
    .replaceAll(/<(?=\/?[A-Za-z])/gu, "\\<");

/**
 * The transcript as Markdown in stella's house style: the title, then each
 * paragraph led by the time it starts at in the recording.
 */
export const transcriptMarkdown = ({
  title,
  paragraphs,
}: Pick<TranscriptBody, "title" | "paragraphs">): string =>
  [
    `# ${markdownText(title)}`,
    ...paragraphs
      .map(({ startMs, text }) => ({ startMs, text: markdownText(text) }))
      .filter(({ text }) => text.length > 0)
      .map(
        ({ startMs, text }) => `**${transcriptTimestamp(startMs)}** ${text}`,
      ),
  ].join("\n\n");

const authorizeTranscriptSave = async (
  request: Request,
  authorizeAccount: typeof authorizeDesktopAccount,
) =>
  await Result.gen(async function* () {
    const account = yield* Result.await(authorizeAccount(request));
    if (
      !isFeatureEnabled(
        account.featureAccessSnapshot,
        REQUIRED_FEATURE_ID,
        account,
      )
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Recording transcription is unavailable",
        }),
      );
    }
    return Result.ok(account);
  });

/** The matter under the member's own access, as a document write sees it. */
const readMatterAccess = async (
  account: DesktopAccount,
  matterId: TranscriptBody["matterId"],
) =>
  await safeDbFromScoped(account.scopedDb)(
    async (tx) =>
      (await tx.query.workspaces.findFirst({
        where: {
          id: { eq: matterId },
          organizationId: { eq: account.organizationId },
        },
        columns: { id: true, status: true },
      })) ?? null,
  );

/**
 * A linked desktop files a recording's transcript in a matter: a Word
 * document in stella's house style, named after the recording, at the
 * matter's root. The member must see the matter and may create documents
 * in it; the text is the member's own, sent once and stored only as the
 * document.
 */
export const createDesktopDictationTranscriptEndpoint = ({
  authorizeAccount = authorizeDesktopAccount,
  readMatter = readMatterAccess,
  createEntity = createEntityFromBuffer,
}: {
  authorizeAccount?: typeof authorizeDesktopAccount;
  readMatter?: typeof readMatterAccess;
  createEntity?: typeof createEntityFromBuffer;
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
        const account = yield* Result.await(
          authorizeTranscriptSave(request, authorizeAccount),
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
        const docx = yield* Result.await(
          markdownToStellaDocx(transcriptMarkdown(body)).then((result) =>
            Result.mapError(
              result,
              // The renderer's own tagged error says what failed.
              (cause) =>
                classifyFailure(
                  new HandlerError({
                    status: 500,
                    message:
                      "The transcript could not be laid out as a document",
                    cause,
                  }),
                  "tagged_failure",
                ),
            ),
          ),
        );
        const created = yield* Result.await(
          createEntity({
            scopedDb: account.scopedDb,
            organizationId: account.organizationId,
            workspaceId: access.value.operation.workspaceId,
            userId: account.userId,
            recordAuditEvent: createAuditRecorder({
              organizationId: account.organizationId,
              userId: account.userId,
              workspaceId: body.matterId,
              request,
              server: null,
            }),
            buffer: docx,
            fileName: sanitizeFilenamePreservingExtension(`${body.title}.docx`),
            mimeType: DOCX_MIME_TYPE,
            encryption: serverBuiltFileEncryption(),
            parentId: null,
          }).then((result) => Result.mapError(result, toHandlerError)),
        );
        return Result.ok({
          fileName: created.fileName,
        } satisfies DesktopDictationTranscriptSaved);
      },
    ),
    {
      type: "independent",
      reason:
        "Creates one document in an authorized matter through the shared document create, which takes its own workspace and entity locks.",
    },
  );

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
      return new HandlerError({
        code: "transcript_matter_file_property_missing",
        status: 422,
        message: "This matter has no file column to hold the transcript.",
      });
    case "InvalidParentError":
      return unreachable("A transcript is always filed at the matter's root");
    default:
      return unreachable("Unhandled createEntityFromBuffer error tag");
  }
};

export const saveDesktopDictationTranscript =
  createDesktopDictationTranscriptEndpoint();
