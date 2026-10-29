import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { entityPath } from "@/state/matter-entities";

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME_TYPE = "application/pdf";

/**
 * Where a file opens: a Word document in folio and a PDF in pdf.js, both the
 * web's own rendering; anything else in the system's Quick Look.
 */
export type DocumentViewer = "docx" | "pdf" | "quick-look";

export const viewerFor = (mimeType: string): DocumentViewer => {
  const type = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (type === DOCX_MIME_TYPE) {
    return "docx";
  }
  return type === PDF_MIME_TYPE ? "pdf" : "quick-look";
};

const versionFileSchema = v.object({
  fieldId: v.pipe(v.string(), v.minLength(1)),
  fileName: v.string(),
  mimeType: v.string(),
});

const versionsSchema = v.object({
  currentVersionId: v.nullish(v.string()),
  versions: v.array(
    v.object({
      id: v.string(),
      file: v.nullable(versionFileSchema),
    }),
  ),
});

export type VersionFile = v.InferOutput<typeof versionFileSchema>;

/**
 * The file of the document as it stands: the current version's, or, when
 * the server names none, the newest version's that has one. The list comes
 * newest first.
 */
export const currentVersionFile = (
  history: v.InferOutput<typeof versionsSchema>,
): VersionFile | null => {
  const current = history.versions.find(
    (version) => version.id === history.currentVersionId,
  );
  return (
    current?.file ??
    history.versions.find((version) => version.file !== null)?.file ??
    null
  );
};

export const versionsPath = (workspaceId: string, entityId: string) =>
  `${entityPath(workspaceId, entityId)}/versions`;

/**
 * `display` asks for what a viewer shows: a Word, Excel or PowerPoint file
 * as stored, a PDF as stored, and anything else as the PDF the server made
 * of it. `download` asks for the stored file itself.
 */
export type FilePurpose = "display" | "download";

export const fileUrlPath = (
  workspaceId: string,
  fieldId: string,
  purpose: FilePurpose,
) =>
  `/v1/files/${encodeURIComponent(workspaceId)}/url/${encodeURIComponent(fieldId)}?purpose=${purpose}`;

const fileUrlSchema = v.object({
  presignedUrl: v.pipe(v.string(), v.url()),
  mimeType: v.string(),
  fileName: v.string(),
  encrypted: v.optional(v.boolean()),
});

/** The document has no file: it was created empty, or its file was removed. */
export class NoFileError extends TaggedError("NoFileError")<{
  message: string;
}> {}

export type DocumentFileError = ApiError | NoFileError;

/** A short-lived, audited link to one document's file, and where it opens. */
export type DocumentFile = {
  readonly fileName: string;
  readonly mimeType: string;
  readonly url: string;
  readonly viewer: DocumentViewer;
};

/**
 * The viewer for a delivered file. A password-protected file opens in Quick
 * Look, which asks for the password; neither folio nor the app can.
 */
export const documentFileOf = (
  delivered: v.InferOutput<typeof fileUrlSchema>,
): DocumentFile => ({
  fileName: delivered.fileName,
  mimeType: delivered.mimeType,
  url: delivered.presignedUrl,
  viewer:
    delivered.encrypted === true ? "quick-look" : viewerFor(delivered.mimeType),
});

/**
 * Whether a refused display can fall back to the stored file: the server
 * answers 400 when it has nothing to show for a type, such as an image or a
 * file it has not converted yet, and Quick Look may still show the original.
 */
export const fallsBackToDownload = (error: ApiError): boolean =>
  error._tag === "ApiRequestError" && error.status === 400;

/** Whether a request failed before any server answered: no connection. */
export const isOffline = (error: DocumentFileError): boolean =>
  error._tag === "ApiRequestError" && error.status === undefined;

/** The current file of one document in a matter, ready to open. */
export const readDocumentFile = async ({
  fetch,
  source,
  workspaceId,
  entityId,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly workspaceId: string;
  readonly entityId: string;
}): Promise<Result<DocumentFile, DocumentFileError>> =>
  await Result.gen(async function* () {
    const history = yield* Result.await(
      requestApi({
        fetch,
        source,
        path: versionsPath(workspaceId, entityId),
        schema: versionsSchema,
      }),
    );
    const file = currentVersionFile(history);
    if (file === null) {
      return Result.err(
        new NoFileError({ message: `Document ${entityId} has no file` }),
      );
    }
    const read = async (purpose: FilePurpose) =>
      await requestApi({
        fetch,
        source,
        path: fileUrlPath(workspaceId, file.fieldId, purpose),
        schema: fileUrlSchema,
      });
    const display = await read("display");
    if (Result.isOk(display)) {
      return Result.ok(documentFileOf(display.value));
    }
    if (!fallsBackToDownload(display.error)) {
      return Result.err(display.error);
    }
    const stored = yield* Result.await(read("download"));
    const original: DocumentFile = {
      ...documentFileOf(stored),
      viewer: "quick-look",
    };
    return Result.ok(original);
  });
