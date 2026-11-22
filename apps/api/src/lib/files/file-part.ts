/**
 * Parts of stored files: the document a signed `.p7m` wraps, a document in a
 * signed container, a member of an ASiC or BDOC container, and the attachments
 * of emails, data-box messages and invoices. One table names, per stored
 * format, which parts it has and how each is read; every read keeps the
 * stored file's access, liveness and delivery audit, and every part is scanned
 * like an upload before it is delivered.
 */
import { Result } from "better-result";

import {
  EMAIL_CITATION_BLOCK_MODE,
  PREVIEW_UNAVAILABLE_ERROR_CODE,
} from "@stll/api-contract";
import { legalFileFormat } from "@stll/api-contract/document-format";
import { resolveEmailMimeType } from "@stll/api-contract/email-mime-types";
import {
  FILE_PART_KINDS,
  type FilePart,
  filePartId,
  type FilePartKind,
} from "@stll/api-contract/file-parts";
import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";
import { classifyFailure } from "@stll/errors";

import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  FileScanRejectedError,
  scanUpload,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  DOCUMENT_ARCHIVE_MAX_BYTES,
  isDocumentArchiveMimeType,
} from "@/api/lib/files/archive-preview-protocol";
import {
  buildEmailPreview,
  emailAttachmentMediaType,
  parseEmail,
} from "@/api/lib/files/email-to-html";
import {
  decodeEmbeddedPart,
  EMBEDDED_PART_WORKER_EXIT,
  EMBEDDED_PART_WORKER_MODE,
} from "@/api/lib/files/embedded-part-protocol";
import {
  type LegalFileReadOptions,
  loadFileSource,
} from "@/api/lib/files/legal-file-source";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { EXTRACTION_WORKER_PATH } from "@/api/lib/search/extract-content";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

/** Room for the reply's header line: a part's name and type. */
const EMBEDDED_PART_HEADER_MAX_BYTES = 4096;

/** A part of a stored file, scanned and ready to deliver. */
export type FilePartRead = {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
};

type PartReader = (
  source: ScannedFile,
  index: number,
) => Promise<Result<FilePartRead, HandlerError>>;

const unavailable = (message: string) =>
  new HandlerError({
    status: 422,
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message,
  });

const noSuchPart = () =>
  new HandlerError({
    status: 404,
    code: "not_found",
    message: "The file has no such part",
  });

/**
 * A part of a container (an ASiC member, a data-box file, a signed
 * container's document, a signed envelope's document, an invoice's
 * attachment), read, typed and scanned in the worker.
 */
const embeddedPart =
  (kind: FilePartKind): PartReader =>
  async (source, index) => {
    // The stored file's own size bound applies when it is loaded; an archive
    // is held to the archive reader's budget there.
    const result = await spawnBinaryWorker({
      workerPath: EXTRACTION_WORKER_PATH,
      args: [
        EMBEDDED_PART_WORKER_MODE,
        String(LIMITS.extractedContentMaxChars),
        source.mimeType,
        filePartId({ kind, index }),
        source.fileName,
      ],
      stdin: new Blob([source.bytes]),
      timeoutMs: LIMITS.extractionTimeoutMs,
      // A compressed member can inflate past its container, never past the
      // archive reader's retained-content budget; a signed envelope's
      // document is never larger than the envelope.
      maxOutputBytes:
        Math.max(DOCUMENT_ARCHIVE_MAX_BYTES, source.bytes.byteLength) +
        EMBEDDED_PART_HEADER_MAX_BYTES,
    });
    if (result.isErr()) {
      const { exitCode } = result.error;
      if (exitCode === EMBEDDED_PART_WORKER_EXIT.noPart) {
        return Result.err(noSuchPart());
      }
      if (exitCode === EMBEDDED_PART_WORKER_EXIT.unreadable) {
        return Result.err(unavailable("The file could not be read"));
      }
      if (exitCode === EMBEDDED_PART_WORKER_EXIT.rejected) {
        return Result.err(
          unavailable("An embedded file did not pass the security scan"),
        );
      }
      return Result.err(
        new HandlerError({
          status: 503,
          code: "upstream_unavailable",
          message: "The embedded file reader is unavailable",
          cause: result.error,
        }),
      );
    }
    const part = decodeEmbeddedPart(result.value);
    return part === null
      ? Result.err(
          classifyFailure(
            new HandlerError({
              status: 500,
              message: "Invalid response from the embedded file reader",
            }),
            "response_invalid",
          ),
        )
      : Result.ok({
          ...part,
          fileName: sanitizeFilenamePreservingExtension(part.fileName),
        });
  };

/** Every stored format and the parts it has; a format with none has `{}`. */
const signedContent = embeddedPart(FILE_PART_KINDS.content);
const containerDocument = embeddedPart(FILE_PART_KINDS.document);
const containerMember = embeddedPart(FILE_PART_KINDS.member);
const embeddedAttachment = embeddedPart(FILE_PART_KINDS.attachment);

const LEGAL_FILE_PARTS = {
  cades: {
    [FILE_PART_KINDS.content]: signedContent,
    // A signed `.xml.p7m` invoice lists its attachments in its preview.
    [FILE_PART_KINDS.attachment]: embeddedAttachment,
  },
  asicE: { [FILE_PART_KINDS.member]: containerMember },
  asicS: { [FILE_PART_KINDS.member]: containerMember },
  eAkta: { [FILE_PART_KINDS.document]: containerDocument },
  zep: { [FILE_PART_KINDS.document]: containerDocument },
  xadesZep: { [FILE_PART_KINDS.document]: containerDocument },
  dataBox: { [FILE_PART_KINDS.attachment]: embeddedAttachment },
  isdoc: { [FILE_PART_KINDS.attachment]: embeddedAttachment },
  isdocx: { [FILE_PART_KINDS.attachment]: embeddedAttachment },
  xml: { [FILE_PART_KINDS.attachment]: embeddedAttachment },
  uyap: {},
  ofd: {},
} as const satisfies Record<
  LegalFileFormatKind,
  Partial<Record<FilePartKind, PartReader>>
>;

const EMAIL_FORMAT = "email";

/** An email's attachment, as its preview lists it, scanned in this process. */
const emailAttachment: PartReader = async (source, index) => {
  const parsed = await parseEmail(source.bytes, source.mimeType);
  if (parsed.isErr()) {
    return Result.err(unavailable("The email could not be read"));
  }
  const listed = buildEmailPreview(parsed.value, {
    citationBlockMode: EMAIL_CITATION_BLOCK_MODE.omit,
  }).attachments.includes(index);
  const attachment = listed ? parsed.value.attachments.at(index) : undefined;
  if (attachment === undefined) {
    return Result.err(noSuchPart());
  }
  const fileName = sanitizeFilenamePreservingExtension(
    attachment.fileName ?? "attachment",
  );
  const mimeType = await emailAttachmentMediaType(attachment);
  if (attachment.bytes.byteLength === 0) {
    return Result.err(unavailable("The attachment is empty"));
  }
  const scanned = await scanUpload({
    bytes: attachment.bytes,
    declaredMimeType: mimeType,
    fileName,
  });
  if (scanned.isErr()) {
    return Result.err(
      FileScanRejectedError.is(scanned.error)
        ? unavailable("An embedded file did not pass the security scan")
        : new HandlerError({
            status: 503,
            code: "upstream_unavailable",
            message: "The file security scan is unavailable",
            cause: scanned.error,
          }),
    );
  }
  return Result.ok({
    bytes: new Uint8Array(scanned.value.bytes),
    fileName,
    mimeType,
  });
};

type PartSourceFormat = {
  readonly reader: PartReader | undefined;
  readonly mimeType: string;
  readonly auditFormat: string;
  readonly maxBytes?: number | undefined;
};

const partSourceFormat =
  ({ kind }: FilePart) =>
  (content: {
    mimeType: string;
    fileName: string;
  }): PartSourceFormat | null => {
    const legal = legalFileFormat(content.mimeType, content.fileName);
    if (legal !== undefined) {
      const readers: Partial<Record<FilePartKind, PartReader>> =
        LEGAL_FILE_PARTS[legal.kind];
      return {
        reader: readers[kind],
        mimeType: legal.mimeType,
        auditFormat: legal.auditFormat,
        ...(isDocumentArchiveMimeType(legal.mimeType)
          ? { maxBytes: DOCUMENT_ARCHIVE_MAX_BYTES }
          : {}),
      };
    }
    const email = resolveEmailMimeType(content);
    return email === null
      ? null
      : {
          reader:
            kind === FILE_PART_KINDS.attachment ? emailAttachment : undefined,
          mimeType: email,
          auditFormat: EMAIL_FORMAT,
          maxBytes: FILE_SIZE_LIMIT_BYTES.document,
        };
  };

export type FilePartReadOptions = LegalFileReadOptions & {
  readonly part: FilePart;
  readonly disposition: "attachment" | "inline";
};

/**
 * One part of a matter file. The part is read outside any lock and released
 * only while the same live version is share-locked, after its delivery has
 * been recorded with the part it was.
 */
export const readFilePart = async ({
  part,
  disposition,
  ...options
}: FilePartReadOptions): Promise<
  Result<FilePartRead & { entityId: SafeId<"entity"> }, HandlerError>
> => {
  const loaded = await loadFileSource(options, partSourceFormat(part));
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const { source, format, entityId, deliver } = loaded.value;
  if (format.reader === undefined) {
    return Result.err(noSuchPart());
  }
  const read = await format.reader(
    source.withMimeType(format.mimeType),
    part.index,
  );
  if (read.isErr()) {
    return Result.err(read.error);
  }
  const delivered = await deliver(
    (): Result<FilePartRead, HandlerError> => Result.ok(read.value),
    { disposition, part: filePartId(part) },
  );
  return delivered.isErr()
    ? Result.err(delivered.error)
    : Result.ok({ ...delivered.value, entityId });
};
