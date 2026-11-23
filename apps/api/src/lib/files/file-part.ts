/**
 * Parts of stored files: the document a signed `.p7m` wraps, a document in a
 * signed container, a member of an ASiC or BDOC container or a ZIP archive,
 * a mailbox's message, and the attachments of emails, data-box messages and
 * invoices. One table names, per stored format, which parts it has and how
 * each is read: from the stored file's bytes, or (a mailbox, which is never
 * held whole) by streaming the stored object. Every read keeps the stored
 * file's access, liveness and delivery audit, and every part is scanned like
 * an upload before it is delivered. A part that is itself a container is
 * read in turn, down its path, in the worker.
 */
import { Result } from "better-result";
import * as v from "valibot";

import {
  EMAIL_CITATION_BLOCK_MODE,
  PREVIEW_UNAVAILABLE_ERROR_CODE,
} from "@stll/api-contract";
import { legalFileFormat } from "@stll/api-contract/document-format";
import {
  EML_MIME_TYPE,
  resolveEmailMimeType,
} from "@stll/api-contract/email-mime-types";
import {
  FILE_PART_KINDS,
  FILE_PART_MAX_DEPTH,
  type FilePart,
  filePartDepth,
  filePartId,
  type FilePartKind,
  type FilePartList,
  filePartListSchema,
  filePartWithin,
  parseFilePartId,
  splitOutermostFilePart,
} from "@stll/api-contract/file-parts";
import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";
import { classifyFailure } from "@stll/errors";

import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { FileKey } from "@/api/lib/file-key";
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
  EMBEDDED_PART_LIST_WORKER_MODE,
  EMBEDDED_PART_WORKER_EXIT,
  EMBEDDED_PART_WORKER_MODE,
} from "@/api/lib/files/embedded-part-protocol";
import {
  type LegalFileReadOptions,
  openFileSource,
} from "@/api/lib/files/legal-file-source";
import {
  MAILBOX_READ_TIMEOUT_MS,
  readStoredMailboxMessage,
} from "@/api/lib/files/mailbox-file";
import { FILE_SIZE_LIMIT_BYTES, LIMITS } from "@/api/lib/limits";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { EXTRACTION_WORKER_PATH } from "@/api/lib/search/extract-content";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

/** Room for the reply's header line: a part's name and type. */
const EMBEDDED_PART_HEADER_MAX_BYTES = 4096;

/** A container's list: at most the archive reader's entries, a row each. */
const PART_LIST_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const PART_LIST_REPLY = v.pipe(v.string(), v.parseJson(), filePartListSchema);

/** A part of a stored file, scanned and ready to deliver. */
export type FilePartRead = {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
};

type PartReader = (
  source: ScannedFile,
  part: FilePart,
) => Promise<Result<FilePartRead, HandlerError>>;

/** A stored file read from its object, never loaded whole. */
type StoredObject = {
  readonly key: FileKey;
  readonly fileName: string;
};

/**
 * A part read from the stored object, and the scanned file it opens as
 * (a mailbox's message): its own parts are read from that file.
 */
type ObjectPartReader = (
  source: StoredObject,
  part: FilePart,
) => Promise<Result<ScannedFile, HandlerError>>;

/** How a format's part is read: from the file's bytes, or its object. */
type PartReading =
  | { readonly from: "bytes"; readonly read: PartReader }
  | { readonly from: "object"; readonly read: ObjectPartReader };

const fromBytes = (read: PartReader): PartReading => ({ from: "bytes", read });

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

const workerFailure = (
  exitCode: number | null,
  cause: unknown,
): HandlerError => {
  if (exitCode === EMBEDDED_PART_WORKER_EXIT.noPart) {
    return noSuchPart();
  }
  if (exitCode === EMBEDDED_PART_WORKER_EXIT.unreadable) {
    return unavailable("The file could not be read");
  }
  if (exitCode === EMBEDDED_PART_WORKER_EXIT.rejected) {
    return unavailable("An embedded file did not pass the security scan");
  }
  return new HandlerError({
    status: 503,
    code: "upstream_unavailable",
    message: "The embedded file reader is unavailable",
    cause,
  });
};

const invalidReply = () =>
  classifyFailure(
    new HandlerError({
      status: 500,
      message: "Invalid response from the embedded file reader",
    }),
    "response_invalid",
  );

/**
 * A part of a container (an ASiC member, a file in an archive, a data-box
 * file, a signed container's document, a signed envelope's document, an
 * invoice's attachment, or a part of any of these), read, typed and scanned
 * in the worker, down the part's path.
 */
const embeddedPart: PartReader = async (source, part) => {
  // The stored file's own size bound applies when it is loaded; an archive
  // is held to the archive reader's budget there.
  const result = await spawnBinaryWorker({
    workerPath: EXTRACTION_WORKER_PATH,
    args: [
      EMBEDDED_PART_WORKER_MODE,
      String(LIMITS.extractedContentMaxChars),
      source.mimeType,
      filePartId(part),
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
    return Result.err(workerFailure(result.error.exitCode, result.error));
  }
  const read = decodeEmbeddedPart(result.value);
  return read === null
    ? Result.err(invalidReply())
    : Result.ok({
        ...read,
        fileName: sanitizeFilenamePreservingExtension(read.fileName),
      });
};

const scanFailure = (error: unknown) =>
  FileScanRejectedError.is(error)
    ? unavailable("An embedded file did not pass the security scan")
    : new HandlerError({
        status: 503,
        code: "upstream_unavailable",
        message: "The file security scan is unavailable",
        cause: error,
      });

/**
 * A mailbox's message (`message:N`), read by streaming the stored mailbox as
 * far as the message and reading the message alone by its range, then
 * scanned like an upload of it: an email named after its subject.
 */
const mailboxMessage: ObjectPartReader = async ({ key, fileName }, part) => {
  const read = await readStoredMailboxMessage({
    key,
    fileName,
    index: part.index,
    signal: AbortSignal.timeout(MAILBOX_READ_TIMEOUT_MS),
  });
  if (read.isErr()) {
    const { error } = read;
    if ("_tag" in error) {
      return Result.err(unavailable("The mailbox could not be read"));
    }
    if (error.type === "noMessage") {
      return Result.err(noSuchPart());
    }
    return Result.err(
      unavailable(
        error.entry.unavailable === "tooLarge"
          ? "The message is too large to open"
          : "The message could not be read",
      ),
    );
  }
  const { entry, bytes } = read.value;
  const scanned = await scanUpload({
    bytes,
    declaredMimeType: EML_MIME_TYPE,
    fileName: entry.fileName,
  });
  return scanned.isErr()
    ? Result.err(scanFailure(scanned.error))
    : Result.ok(scanned.value.withMimeType(EML_MIME_TYPE));
};

/** Every stored format and the parts it has; a format with none has `{}`. */
export const LEGAL_FILE_PARTS = {
  cades: {
    [FILE_PART_KINDS.content]: fromBytes(embeddedPart),
    // A signed `.xml.p7m` invoice lists its attachments in its preview.
    [FILE_PART_KINDS.attachment]: fromBytes(embeddedPart),
  },
  asicE: { [FILE_PART_KINDS.member]: fromBytes(embeddedPart) },
  asicS: { [FILE_PART_KINDS.member]: fromBytes(embeddedPart) },
  eAkta: { [FILE_PART_KINDS.document]: fromBytes(embeddedPart) },
  zep: { [FILE_PART_KINDS.document]: fromBytes(embeddedPart) },
  xadesZep: { [FILE_PART_KINDS.document]: fromBytes(embeddedPart) },
  dataBox: { [FILE_PART_KINDS.attachment]: fromBytes(embeddedPart) },
  isdoc: { [FILE_PART_KINDS.attachment]: fromBytes(embeddedPart) },
  isdocx: { [FILE_PART_KINDS.attachment]: fromBytes(embeddedPart) },
  xml: { [FILE_PART_KINDS.attachment]: fromBytes(embeddedPart) },
  zip: { [FILE_PART_KINDS.member]: fromBytes(embeddedPart) },
  mbox: { [FILE_PART_KINDS.message]: { from: "object", read: mailboxMessage } },
  uyap: {},
  ofd: {},
} as const satisfies Record<
  LegalFileFormatKind,
  Partial<Record<FilePartKind, PartReading>>
>;

const EMAIL_FORMAT = "email";

/**
 * An email's attachment, as its preview lists it, scanned in this process; a
 * part of an attachment is read in the worker, as any nested part is.
 */
const emailAttachment: PartReader = async (source, part) => {
  if (part.within !== undefined) {
    return await embeddedPart(source, part);
  }
  const { index } = part;
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
    return Result.err(scanFailure(scanned.error));
  }
  return Result.ok({
    bytes: new Uint8Array(scanned.value.bytes),
    fileName,
    mimeType,
  });
};

type PartSourceFormat = {
  readonly reader: PartReading | undefined;
  readonly mimeType: string;
  readonly auditFormat: string;
  readonly maxBytes?: number | undefined;
};

/** The part of the stored file itself that `part` sits in, or is. */
const outermost = (part: FilePart): FilePart =>
  part.within === undefined ? part : outermost(part.within);

const partSourceFormat =
  (part: FilePart) =>
  (content: {
    mimeType: string;
    fileName: string;
  }): PartSourceFormat | null => {
    const legal = legalFileFormat(content.mimeType, content.fileName);
    if (legal !== undefined) {
      const readers: Partial<Record<FilePartKind, PartReading>> =
        LEGAL_FILE_PARTS[legal.kind];
      return {
        reader: readers[outermost(part).kind],
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
            outermost(part).kind === FILE_PART_KINDS.attachment
              ? fromBytes(emailAttachment)
              : undefined,
          mimeType: email,
          auditFormat: EMAIL_FORMAT,
          maxBytes: FILE_SIZE_LIMIT_BYTES.document,
        };
  };

/** A stored file as a part reader finds it: its object, loaded on demand. */
type PartSource = StoredObject & {
  readonly load: () => Promise<Result<ScannedFile, HandlerError>>;
};

/**
 * The file a part opened from an object opens as (a mailbox's message),
 * read from the object, and the path of `part` within it; null when `part`
 * is that file itself.
 */
const openObjectPart = async (
  read: ObjectPartReader,
  source: StoredObject,
  part: FilePart,
) => {
  const { outermost: opened, inner } = splitOutermostFilePart(part);
  const file = await read(source, opened);
  return file.map((value) => ({ file: value, opened, inner }));
};

const readPart = async (
  source: PartSource,
  format: PartSourceFormat,
  part: FilePart,
): Promise<Result<FilePartRead, HandlerError>> => {
  const { reader } = format;
  if (reader === undefined) {
    return Result.err(noSuchPart());
  }
  if (reader.from === "bytes") {
    const loaded = await source.load();
    return loaded.isErr()
      ? Result.err(loaded.error)
      : await reader.read(loaded.value.withMimeType(format.mimeType), part);
  }
  const opened = await openObjectPart(reader.read, source, part);
  if (opened.isErr()) {
    return Result.err(opened.error);
  }
  const { file, inner } = opened.value;
  return inner === null
    ? Result.ok({
        bytes: new Uint8Array(file.bytes),
        fileName: sanitizeFilenamePreservingExtension(file.fileName),
        mimeType: file.mimeType,
      })
    : await readPartOfFile(file, inner);
};

/**
 * One part of a stored file's bytes, read as the part link reads it once the
 * file is loaded: by the same format table, reader, typing and scan.
 */
export const readPartOfFile = async (
  source: ScannedFile,
  part: FilePart,
): Promise<Result<FilePartRead, HandlerError>> => {
  const format = partSourceFormat(part)(source);
  const reader = format?.reader;
  // A format read from its stored object (a mailbox) has no parts once it
  // is only bytes, such as inside another file: the worker reads those.
  return format === null || reader?.from !== "bytes"
    ? Result.err(noSuchPart())
    : await reader.read(source.withMimeType(format.mimeType), part);
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
  const opened = await openFileSource(options, partSourceFormat(part));
  if (opened.isErr()) {
    return Result.err(opened.error);
  }
  const { format, entityId, deliver } = opened.value;
  const read = await readPart(opened.value, format, part);
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

/** A listed part's address, addressed through the part it was listed in. */
const nestedPartId = (id: string, container: FilePart): string => {
  const listed = parseFilePartId(id);
  return listed === null ? id : filePartId(filePartWithin(listed, container));
};

/**
 * The files of `file`'s part at `part`, a container, or of `file` itself
 * when `part` is null, listed in the worker as reading each delivers it.
 */
const listPartsInWorker = async (
  file: ScannedFile,
  part: FilePart | null,
): Promise<Result<FilePartList, HandlerError>> => {
  const result = await spawnBinaryWorker({
    workerPath: EXTRACTION_WORKER_PATH,
    args: [
      EMBEDDED_PART_LIST_WORKER_MODE,
      String(LIMITS.extractedContentMaxChars),
      file.mimeType,
      part === null ? "" : filePartId(part),
      file.fileName,
    ],
    stdin: new Blob([file.bytes]),
    timeoutMs: LIMITS.extractionTimeoutMs,
    maxOutputBytes: PART_LIST_MAX_OUTPUT_BYTES,
  });
  if (result.isErr()) {
    return Result.err(workerFailure(result.error.exitCode, result.error));
  }
  const parsed = v.safeParse(
    PART_LIST_REPLY,
    new TextDecoder().decode(result.value),
  );
  return parsed.success ? Result.ok(parsed.output) : Result.err(invalidReply());
};

/**
 * The files of a part that is itself a container, listed in the worker as
 * reading each delivers it. Its delivery is recorded with the part it was,
 * as the part's own preview would be; a part already as deep as a part may
 * sit lists no parts.
 */
export const readFilePartList = async ({
  part,
  ...options
}: LegalFileReadOptions & { readonly part: FilePart }): Promise<
  Result<FilePartList, HandlerError>
> => {
  if (filePartDepth(part) >= FILE_PART_MAX_DEPTH) {
    return Result.err(noSuchPart());
  }
  const opened = await openFileSource(options, partSourceFormat(part));
  if (opened.isErr()) {
    return Result.err(opened.error);
  }
  const { format, deliver } = opened.value;
  const { reader } = format;
  if (reader === undefined) {
    return Result.err(noSuchPart());
  }
  let listing: Result<FilePartList, HandlerError>;
  if (reader.from === "bytes") {
    const source = await opened.value.load();
    listing = source.isErr()
      ? Result.err(source.error)
      : await listPartsInWorker(
          source.value.withMimeType(format.mimeType),
          part,
        );
  } else {
    // The parts of a message are listed from the message, then addressed
    // through it.
    const message = await openObjectPart(reader.read, opened.value, part);
    listing = message.isErr()
      ? Result.err(message.error)
      : (await listPartsInWorker(message.value.file, message.value.inner)).map(
          ({ files }) => ({
            files: files.map((file) => ({
              ...file,
              part:
                file.part === null
                  ? null
                  : {
                      ...file.part,
                      part: nestedPartId(file.part.part, message.value.opened),
                    },
            })),
          }),
        );
  }
  if (listing.isErr()) {
    return Result.err(listing.error);
  }
  const listed = listing.value;
  return await deliver(
    (): Result<FilePartList, HandlerError> => Result.ok(listed),
    { part: filePartId(part) },
  );
};
