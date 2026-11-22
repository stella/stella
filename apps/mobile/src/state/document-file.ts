import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { asicPreviewSchema } from "@stll/api-contract/asic";
import { cadesPreviewSchema } from "@stll/api-contract/cades";
import { certifiedEmailReadSchema } from "@stll/api-contract/certified-email";
import { DATA_BOX_DOCUMENT_KINDS } from "@stll/api-contract/data-box";
import {
  documentFormat,
  legalFileFormat,
} from "@stll/api-contract/document-format";
import { eInvoicePreviewSchema } from "@stll/api-contract/e-invoice";
import { signedDossierPreviewSchema } from "@stll/api-contract/signed-dossier";
import { structuredDocumentPreviewSchema } from "@stll/api-contract/structured-document";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { entityPath } from "@/state/matter-entities";

export const DOCX_MIME_TYPE =
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
  /** The document's file column, which an edit names. */
  propertyId: v.pipe(v.string(), v.minLength(1)),
  fileName: v.string(),
  mimeType: v.string(),
});

const versionsSchema = v.object({
  currentVersionId: v.nullish(v.string()),
  versions: v.array(
    v.object({
      id: v.string(),
      versionNumber: v.pipe(v.number(), v.integer()),
      file: v.nullable(versionFileSchema),
    }),
  ),
});

/** A version's file, and the number of the version it is of. */
export type VersionFile = v.InferOutput<typeof versionFileSchema> & {
  readonly versionNumber: number;
};

/**
 * The file of the document as it stands: the current version's, or, when
 * the server names none, the newest version's that has one. The list comes
 * newest first.
 */
export const currentVersionFile = (
  history: v.InferOutput<typeof versionsSchema>,
): VersionFile | null => {
  const withFile = history.versions.filter((version) => version.file !== null);
  const shown =
    withFile.find((version) => version.id === history.currentVersionId) ??
    withFile.at(0);
  return shown?.file
    ? { ...shown.file, versionNumber: shown.versionNumber }
    : null;
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

const dataBoxPreviewSchema = v.object({
  kind: v.picklist(DATA_BOX_DOCUMENT_KINDS),
  text: v.string(),
});

type DataBoxDocumentFile = {
  readonly viewer: "dataBox";
  readonly fileName: string;
  readonly fieldId: string;
  readonly preview: Result<
    v.InferOutput<typeof dataBoxPreviewSchema>,
    ApiError
  >;
};

type CadesDocumentFile = {
  readonly viewer: "cades";
  readonly fileName: string;
  readonly fieldId: string;
  readonly preview: Result<v.InferOutput<typeof cadesPreviewSchema>, ApiError>;
};

type AsicDocumentFile = {
  readonly viewer: "asic";
  readonly fileName: string;
  readonly fieldId: string;
  readonly preview: Result<v.InferOutput<typeof asicPreviewSchema>, ApiError>;
};

type SignedDossierDocumentFile = {
  readonly viewer: "signed-dossier";
  readonly fileName: string;
  readonly fieldId: string;
  readonly preview: Result<
    v.InferOutput<typeof signedDossierPreviewSchema>,
    ApiError
  >;
};

type StructuredDocumentFile = {
  readonly viewer: "structured-document";
  readonly fileName: string;
  readonly fieldId: string;
  readonly preview: Result<
    v.InferOutput<typeof structuredDocumentPreviewSchema>,
    ApiError
  >;
};

type EInvoiceDocumentFile = {
  readonly viewer: "e-invoice";
  /**
   * The format its name or type claims. Any XML file is read as a possible
   * invoice, so a refused `xml` read means it is not one.
   */
  readonly format: "isdoc" | "isdocx" | "xml";
  readonly fileName: string;
  readonly fieldId: string;
  readonly preview: Result<
    v.InferOutput<typeof eInvoicePreviewSchema>,
    ApiError
  >;
};

/** An .eml file its content shows to be a certified email (Italian PEC). */
type CertifiedEmailDocumentFile = {
  readonly viewer: "certifiedEmail";
  readonly fileName: string;
  readonly fieldId: string;
  readonly preview: Result<
    v.InferOutput<typeof certifiedEmailReadSchema>,
    ApiError
  >;
};

export type LegalDocumentFile =
  | AsicDocumentFile
  | CadesDocumentFile
  | CertifiedEmailDocumentFile
  | DataBoxDocumentFile
  | EInvoiceDocumentFile
  | SignedDossierDocumentFile
  | StructuredDocumentFile;

export type DocumentFile = NativeDocumentFile | LegalDocumentFile;

export const readOriginalDocumentFile = async ({
  fetch,
  source,
  workspaceId,
  fieldId,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly workspaceId: string;
  readonly fieldId: string;
}) =>
  await requestApi({
    fetch,
    source,
    path: fileUrlPath(workspaceId, fieldId, "download"),
    schema: fileUrlSchema,
  });

/** The document has no file: it was created empty, or its file was removed. */
class NoFileError extends TaggedError("NoFileError")<{
  message: string;
}> {}

export type DocumentFileError = ApiError | NoFileError;

/** A short-lived, audited link to one document's file, and where it opens. */
type NativeDocumentFile = {
  /** The document's file column, which an edit names. */
  readonly propertyId: string;
  /** The version the file is of, which an edit must start from. */
  readonly versionNumber: number;
  readonly fileName: string;
  readonly mimeType: string;
  readonly url: string;
  readonly viewer: DocumentViewer;
};

/**
 * The viewer for a delivered file. A password-protected file opens in Quick
 * Look, which asks for the password; neither folio nor the app can.
 */
const documentFileOf = (
  delivered: v.InferOutput<typeof fileUrlSchema>,
  { propertyId, versionNumber }: VersionFile,
): NativeDocumentFile => ({
  propertyId,
  versionNumber,
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
const fallsBackToDownload = (error: ApiError): boolean =>
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
    const { fieldId, fileName, mimeType } = file;
    const kind = legalFileFormat(mimeType, fileName)?.kind;
    switch (kind) {
      case "asicE":
      case "asicS": {
        const preview = await requestApi({
          fetch,
          source,
          path: `/v1/files/${encodeURIComponent(workspaceId)}/asic/${encodeURIComponent(fieldId)}`,
          schema: asicPreviewSchema,
        });
        return Result.ok({
          viewer: "asic",
          fileName,
          fieldId,
          preview,
        } satisfies AsicDocumentFile);
      }
      case "cades": {
        const preview = await requestApi({
          fetch,
          source,
          path: `/v1/files/${encodeURIComponent(workspaceId)}/cades/${encodeURIComponent(fieldId)}`,
          schema: cadesPreviewSchema,
        });
        return Result.ok({ viewer: kind, fileName, fieldId, preview });
      }
      case "dataBox": {
        const preview = await requestApi({
          fetch,
          source,
          path: `/v1/files/${encodeURIComponent(workspaceId)}/data-box/${encodeURIComponent(fieldId)}`,
          schema: dataBoxPreviewSchema,
        });
        return Result.ok({ viewer: kind, fileName, fieldId, preview });
      }
      case "eAkta":
      case "xadesZep":
      case "zep": {
        const preview = await requestApi({
          fetch,
          source,
          path: `/v1/files/${encodeURIComponent(workspaceId)}/signed-dossier/${encodeURIComponent(fieldId)}`,
          schema: signedDossierPreviewSchema,
        });
        return Result.ok({
          viewer: "signed-dossier",
          fileName,
          fieldId,
          preview,
        } satisfies SignedDossierDocumentFile);
      }
      case "ofd":
      case "uyap": {
        const preview = await requestApi({
          fetch,
          source,
          path: `/v1/files/${encodeURIComponent(workspaceId)}/structured-document/${encodeURIComponent(fieldId)}`,
          schema: structuredDocumentPreviewSchema,
        });
        return Result.ok({
          viewer: "structured-document",
          fileName,
          fieldId,
          preview,
        } satisfies StructuredDocumentFile);
      }
      case "isdoc":
      case "isdocx":
      case "xml": {
        const preview = await requestApi({
          fetch,
          source,
          path: `/v1/files/${encodeURIComponent(workspaceId)}/e-invoice/${encodeURIComponent(fieldId)}`,
          schema: eInvoicePreviewSchema,
        });
        // Any XML file is tried as an invoice; one the server does not read
        // as an invoice opens as before, like any other file.
        const notAnInvoice =
          kind === "xml" &&
          Result.isError(preview) &&
          preview.error._tag === "ApiRequestError" &&
          preview.error.code === PREVIEW_UNAVAILABLE_ERROR_CODE;
        if (notAnInvoice) {
          break;
        }
        return Result.ok({
          viewer: "e-invoice",
          format: kind,
          fileName,
          fieldId,
          preview,
        } satisfies EInvoiceDocumentFile);
      }
      case undefined:
        break;
      default:
        kind satisfies never;
        return panic("Unsupported legal file viewer");
    }
    // Only the content tells a certified email from any other .eml: the
    // server reads it and refuses any other email, which opens as before.
    const format = documentFormat(mimeType, fileName);
    if (format.kind === "email" && format.label === "EML") {
      const preview = await requestApi({
        fetch,
        source,
        path: `/v1/files/${encodeURIComponent(workspaceId)}/certified-email/${encodeURIComponent(fieldId)}`,
        schema: certifiedEmailReadSchema,
      });
      const notCertified =
        Result.isError(preview) &&
        preview.error._tag === "ApiRequestError" &&
        preview.error.code === PREVIEW_UNAVAILABLE_ERROR_CODE;
      if (!notCertified) {
        return Result.ok({
          viewer: "certifiedEmail",
          fileName,
          fieldId,
          preview,
        } satisfies CertifiedEmailDocumentFile);
      }
    }
    const display = await requestApi({
      fetch,
      source,
      path: fileUrlPath(workspaceId, fieldId, "display"),
      schema: fileUrlSchema,
    });
    if (Result.isOk(display)) {
      return Result.ok(documentFileOf(display.value, file));
    }
    if (!fallsBackToDownload(display.error)) {
      return Result.err(display.error);
    }
    const stored = yield* Result.await(
      readOriginalDocumentFile({ fetch, source, workspaceId, fieldId }),
    );
    const original: NativeDocumentFile = {
      ...documentFileOf(stored, file),
      viewer: "quick-look",
    };
    return Result.ok(original);
  });
