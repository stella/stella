/**
 * The one place a file the member's browser downloaded for a chat is filed
 * with stella, whichever path brought it (a run on the member's computer, or
 * the chat page for a chat on stella's models).
 *
 * The file goes only where the chat itself is: into the chat's own matter as
 * a document, and never into another matter or organization; a chat in no
 * matter keeps it as a file of the chat. A matter document records where it
 * came from as a `browser-download` document source. Bytes the matter
 * already holds as a document's current file are not stored again: the
 * document that holds them is named instead.
 *
 * Only PDFs are filed, read by their bytes. They go through the same scan,
 * encryption detection and document write owners as any upload, so OCR,
 * search, permissions and audit treat them as uploaded files.
 *
 * Two filings of the same bytes at once still make one document: a
 * matter's documents are created one at a time (its creation lock), and a
 * filing that finds the same bytes filed inside that lock rolls its own
 * document back and names the other.
 */
import { panic, Result } from "better-result";

import {
  BROWSER_DOWNLOAD_REFUSAL_CODE,
  type BrowserDownloadFiled,
  type BrowserDownloadOrigin,
  storedBrowserDownloadAddress,
} from "@stll/api-contract/browser-downloads";
import { sha256Hex } from "@stll/sha256/bun";

import type { SafeDb, SafeDbError, ScopedDb } from "@/api/db/safe-db-types";
import {
  uploadUserFile,
  type UploadUserFileDependencies,
} from "@/api/handlers/chat/upload-files";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";
import type { DocumentSource } from "@/api/lib/document-source";
import {
  authorizeDocumentWriteAccess,
  documentWriteRefusalHandlerError,
  DocumentWriteRefusedError,
} from "@/api/lib/entities/authorize-document-write";
import { CALLER_AUTHORIZED } from "@/api/lib/entities/buffer-write-authority";
import {
  createEntityFromBufferOnce,
  SameBytesFiledError,
} from "@/api/lib/entities/create-from-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import {
  detectFileEncryption,
  uploadFileEncryption,
} from "@/api/lib/files/detect-file-encryption";
import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "@/api/lib/files/organization-file-usage";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { findExactDuplicates } from "@/api/lib/uploads/exact-duplicates";

const PDF_MIME_TYPE = "application/pdf";
const PDF_MAGIC = new TextEncoder().encode("%PDF-");

type BrowserDownloadSource = Extract<
  DocumentSource,
  { kind: "browser-download" }
>;

/** The chat a download is filed for, as the caller verified it. */
type BrowserDownloadChat = {
  threadId: SafeId<"chatThread">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  memberRole: AuthorizedMemberRole;
  /**
   * The chat's own matter: null for a chat in no matter. Its `workspace` is
   * the matter as the member may reach it now, null when they no longer can;
   * the download is then refused, never filed elsewhere.
   */
  matter: {
    id: SafeId<"workspace">;
    workspace: AccessibleWorkspace | null;
  } | null;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  recordAuditEvent: AuditRecorder;
};

export type FileBrowserDownloadDependencies = {
  createEntityFromBuffer?: typeof createEntityFromBufferOnce;
  uploads?: UploadUserFileDependencies;
};

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= PDF_MAGIC.length &&
  PDF_MAGIC.every((byte, index) => bytes[index] === byte);

const refused = (
  status: 409 | 413 | 422,
  code: string,
  message: string,
): HandlerError => new HandlerError({ status, code, message });

/** Every event of a matter write names the matter. */
const inMatter =
  (record: AuditRecorder, workspaceId: SafeId<"workspace">): AuditRecorder =>
  async (tx, event) => {
    const events = Array.isArray(event) ? event : [event];
    for (const one of events) {
      if (one.workspaceId === undefined) {
        one.workspaceId = workspaceId;
      }
    }
    await record(tx, events);
  };

/** The bytes checked like an upload: scanned, then their encryption detected. */
const inspectPdf = async (bytes: Uint8Array, fileName: string) => {
  const scanned = await scanUpload({
    bytes,
    ownership: "transfer",
    declaredMimeType: PDF_MIME_TYPE,
    fileName,
  });
  if (Result.isError(scanned)) {
    return Result.err(
      FileScanRejectedError.is(scanned.error)
        ? new HandlerError({
            ...scanned.error.rejection,
            status: 422,
            code: BROWSER_DOWNLOAD_REFUSAL_CODE.rejected,
          })
        : refused(
            422,
            BROWSER_DOWNLOAD_REFUSAL_CODE.rejected,
            "The file could not be checked, so it was not filed",
          ),
    );
  }
  const encryption = uploadFileEncryption(
    await detectFileEncryption({
      mimeType: PDF_MIME_TYPE,
      scanned: scanned.value,
    }),
    handlerErrorContext("browserDownload.detectEncryption", {
      sizeBytes: String(scanned.value.bytes.byteLength),
    }),
  );
  if (encryption === null) {
    return Result.err(
      refused(
        422,
        BROWSER_DOWNLOAD_REFUSAL_CODE.unreadable,
        "The PDF appears damaged, so it was not filed",
      ),
    );
  }
  return Result.ok({ scanned: scanned.value, encryption });
};

type CreateFailure =
  | { _tag: "DocumentTooLargeError" }
  | { _tag: "EntityLimitError" }
  | { _tag: "InvalidParentError" }
  | { _tag: "MissingFilePropertyError" }
  | DocumentWriteRefusedError
  | OrganizationFileUsageError;

const storeFailure = (error: CreateFailure): HandlerError => {
  if (error instanceof OrganizationFileUsageError) {
    return organizationFileUsageHandlerError(error);
  }
  if (DocumentWriteRefusedError.is(error)) {
    return documentWriteRefusalHandlerError(error);
  }
  switch (error._tag) {
    case "DocumentTooLargeError":
      return refused(
        413,
        BROWSER_DOWNLOAD_REFUSAL_CODE.notStored,
        "The file is larger than the matter's documents may be",
      );
    case "EntityLimitError":
      return refused(
        409,
        BROWSER_DOWNLOAD_REFUSAL_CODE.notStored,
        "The matter has reached its document limit",
      );
    case "MissingFilePropertyError":
      return refused(
        422,
        BROWSER_DOWNLOAD_REFUSAL_CODE.notStored,
        "The matter cannot store documents",
      );
    case "InvalidParentError":
      // A download is filed at the matter's root: no folder is named.
      return panic("A browser download names no folder");
    default:
      return panic("Unhandled browser download store failure");
  }
};

type FileBrowserDownloadInput = {
  chat: BrowserDownloadChat;
  bytes: Uint8Array;
  /** The name the page suggested; sanitized by the document and file writers. */
  fileName: string;
  origin: BrowserDownloadOrigin;
  dependencies?: FileBrowserDownloadDependencies;
};

/** Files one download for its chat: see the module's comment. */
export const fileBrowserDownload = async ({
  chat,
  bytes,
  fileName,
  origin,
  dependencies = {},
}: FileBrowserDownloadInput): Promise<
  Result<BrowserDownloadFiled, HandlerError | SafeDbError>
> =>
  await Result.gen(async function* () {
    if (!isPdf(bytes)) {
      return Result.err(
        refused(
          422,
          BROWSER_DOWNLOAD_REFUSAL_CODE.notPdf,
          "Only PDFs are filed, and this file is not one",
        ),
      );
    }
    const { matter } = chat;
    if (matter === null) {
      const stored = yield* Result.await(
        uploadUserFile({
          ...(dependencies.uploads === undefined
            ? {}
            : { dependencies: dependencies.uploads }),
          file: { bytes, fileName, mimeType: PDF_MIME_TYPE },
          organizationId: chat.organizationId,
          recordAuditEvent: chat.recordAuditEvent,
          safeDb: chat.safeDb,
          threadId: chat.threadId,
          userId: chat.userId,
          workspaceId: null,
        }),
      );
      return Result.ok({
        type: "chat_file" as const,
        fileId: stored.id,
        name: stored.fileName,
      });
    }
    const access = authorizeDocumentWriteAccess({
      authority: chat.memberRole,
      workspace: matter.workspace,
      operation: { type: "create", workspaceId: matter.id },
    });
    if (Result.isError(access)) {
      return Result.err(documentWriteRefusalHandlerError(access.error));
    }
    // Hashed before the scan takes ownership of the buffer.
    const contentHash = sha256Hex(bytes);
    const duplicates = yield* Result.await(
      chat.safeDb(
        async (tx) =>
          await findExactDuplicates({
            tx,
            workspaceId: matter.id,
            sha256Hexes: [contentHash],
          }),
      ),
    );
    const existing = duplicates.at(0);
    if (existing !== undefined) {
      return Result.ok({
        type: "document" as const,
        workspaceId: matter.id,
        entityId: existing.entityId,
        name: existing.entityName,
        duplicate: true,
      });
    }
    const { scanned, encryption } = yield* Result.await(
      inspectPdf(bytes, fileName),
    );
    const source: BrowserDownloadSource = {
      kind: "browser-download",
      // Kept without credentials, whoever parsed the origin.
      sourceUrl: storedBrowserDownloadAddress(origin.sourceUrl),
      pageUrl:
        origin.pageUrl === null
          ? null
          : storedBrowserDownloadAddress(origin.pageUrl),
      downloadedAt: origin.downloadedAt,
      contentHash,
    };
    const create =
      dependencies.createEntityFromBuffer ?? createEntityFromBufferOnce;
    const created = await create({
      authority: CALLER_AUTHORIZED,
      scopedDb: chat.scopedDb,
      organizationId: chat.organizationId,
      workspaceId: matter.id,
      userId: chat.userId,
      recordAuditEvent: inMatter(chat.recordAuditEvent, matter.id),
      buffer: scanned.bytes,
      fileName,
      mimeType: PDF_MIME_TYPE,
      encryption,
      scanWarnings: scanned.scanWarnings ?? undefined,
      source,
    });
    if (Result.isError(created)) {
      return SameBytesFiledError.is(created.error)
        ? Result.ok({
            type: "document" as const,
            workspaceId: matter.id,
            entityId: created.error.entityId,
            name: created.error.name,
            duplicate: true,
          })
        : Result.err(storeFailure(created.error));
    }
    return Result.ok({
      type: "document" as const,
      workspaceId: matter.id,
      entityId: created.value.entityId,
      name: created.value.fileName,
      duplicate: false,
    });
  });
