/**
 * Reads the files inside a stored container in the extraction worker: an
 * ASiC or BDOC member, a file in a ZIP archive, a data-box message's file, a
 * signed container's document, the document a signed `.p7m` wraps, an
 * invoice's or an email's attachment. A part that is itself a container is
 * read in turn, down the part's path (`member:2/attachment:0`): every part
 * on the way is typed by `partMediaType`, as its container's list gives it,
 * and scanned exactly as an upload of its bytes would be.
 */
import { panic, Result } from "better-result";

import {
  EMAIL_CITATION_BLOCK_MODE,
  type EmailTextAttachmentCharset,
} from "@stll/api-contract";
import { ASIC_FILE_FORMATS } from "@stll/api-contract/asic-file-formats";
import { resolveEmailMimeType } from "@stll/api-contract/email-mime-types";
import {
  FILE_PART_KINDS_BY_FORMAT,
  type FilePartContainerFormat,
  filePartContainerFormat,
} from "@stll/api-contract/file-part-containers";
import {
  type ContainedFile,
  FILE_PART_KINDS,
  type FilePart,
  filePartId,
  type FilePartKind,
  type FilePartUnavailableReason,
} from "@stll/api-contract/file-parts";
import { LEGAL_FILE_FORMATS } from "@stll/api-contract/legal-file-formats";

import type { DataBoxMessageParseError } from "@/api/lib/email/correspondence/data-box/zfo";
import { parseDataBoxMessage } from "@/api/lib/email/correspondence/data-box/zfo";
import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import {
  type AsicParseError,
  readAsicContainer,
} from "@/api/lib/files/asic-container";
import { scanContainerMember } from "@/api/lib/files/asic-preview-worker";
import { derivePayloadName } from "@/api/lib/files/cades-preview-worker";
import type { DocumentPackageError } from "@/api/lib/files/document-archive";
import {
  invoiceAttachmentPart,
  readStoredInvoice,
} from "@/api/lib/files/e-invoice-worker";
import {
  buildEmailPreview,
  type EmailParseError,
  parseEmail,
} from "@/api/lib/files/email-to-html";
import type { EmbeddedPart } from "@/api/lib/files/embedded-part-protocol";
import { detectEmbeddedPayload } from "@/api/lib/files/embedded-payload-format";
import { type P7mParseError, parseP7m } from "@/api/lib/files/p7m";
import { partMediaType } from "@/api/lib/files/part-media-type";
import {
  readSignedDossier,
  type SignedDossierReadError,
} from "@/api/lib/files/signed-dossier-worker";
import {
  readZipArchive,
  readZipArchiveFile,
} from "@/api/lib/files/zip-archive";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

export type EmbeddedPartError =
  | AsicParseError
  | DataBoxMessageParseError
  | DocumentPackageError
  | EmailParseError
  | FileScanFailedError
  | FileScanRejectedError
  | P7mParseError
  | SignedDossierReadError;

/** A part before it is typed and scanned. */
export type PartCandidate = {
  fileName: string;
  bytes: Uint8Array;
  /** What the container states the part is; a claim the bytes may overrule. */
  statedMimeType: string | null;
  /** The charset the container states for the part's text, if any. */
  charset?: EmailTextAttachmentCharset | null;
};

/**
 * One position in a container's list of parts of one kind: a part that
 * opens, a file the container lists but that does not open, or a position
 * the container's preview does not list (an email's inline image).
 */
type ContainerSlot =
  | {
      readonly type: "part";
      readonly candidate: PartCandidate;
      readonly folder: string | null;
    }
  | {
      readonly type: "unavailable";
      readonly fileName: string;
      readonly folder: string | null;
      readonly sizeBytes: number;
      readonly reason: FilePartUnavailableReason;
    }
  | { readonly type: "unlisted" };

type SlotsResult = Result<ContainerSlot[], EmbeddedPartError>;

const part = (
  candidate: PartCandidate,
  folder: string | null = null,
): ContainerSlot => ({ type: "part", candidate, folder });

/** A container read so far: the stored file, or a part of it. */
type Container = {
  readonly format: FilePartContainerFormat;
  /** The media type its format's reader takes. */
  readonly mimeType: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
};

const legalMimeType = (format: FilePartContainerFormat) =>
  LEGAL_FILE_FORMATS.find(({ kind }) => kind === format)?.mimeType;

/**
 * The container a file is, from the media type it is read as and its name:
 * the stored file's own format type first, else what the type and the name
 * say together, as for a part whose bytes do not show its format.
 */
export const containerOf = ({
  bytes,
  mimeType,
  fileName,
}: {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}): Container | null => {
  const email = resolveEmailMimeType({ mimeType, fileName });
  const format =
    LEGAL_FILE_FORMATS.find((candidate) => candidate.mimeType === mimeType)
      ?.kind ?? filePartContainerFormat(mimeType, fileName);
  if (format === null || format === undefined) {
    return null;
  }
  if (format === "email") {
    return email === null ? null : { format, mimeType: email, fileName, bytes };
  }
  const readAs = legalMimeType(format);
  return readAs === undefined
    ? null
    : { format, mimeType: readAs, fileName, bytes };
};

const asicMembers = async ({
  bytes,
  mimeType,
}: Container): Promise<SlotsResult> => {
  const format = ASIC_FILE_FORMATS.find(
    (candidate) => candidate.mimeType === mimeType,
  );
  if (format === undefined) {
    return Result.ok([]);
  }
  const container = await readAsicContainer(bytes, format.mimeType);
  if (container.isErr()) {
    return Result.err(container.error);
  }
  return Result.ok(
    container.value.members.map((member) =>
      part({
        fileName: member.fileName,
        bytes: member.bytes,
        statedMimeType: null,
      }),
    ),
  );
};

const zipFiles = async ({ bytes }: Container): Promise<SlotsResult> =>
  (await readZipArchive(bytes)).map((files) =>
    files.map((file): ContainerSlot => {
      // A stated name is shown, never used as a path; it is listed and
      // delivered as the safe name its part link gives it.
      const fileName = sanitizeFilenamePreservingExtension(file.fileName);
      const unavailable = (
        reason: FilePartUnavailableReason,
      ): ContainerSlot => ({
        type: "unavailable",
        fileName,
        folder: file.folder,
        sizeBytes: file.sizeBytes,
        reason,
      });
      if (file.unavailable !== null) {
        return unavailable(file.unavailable);
      }
      const read = readZipArchiveFile(file);
      return read.isErr()
        ? unavailable("unreadable")
        : part(
            {
              fileName,
              bytes: new Uint8Array(read.value),
              statedMimeType: null,
            },
            file.folder,
          );
    }),
  );

const dataBoxFiles = ({ bytes }: Container): SlotsResult =>
  parseDataBoxMessage(bytes).map(({ files }) =>
    files.map((file) =>
      part({
        fileName: sanitizeFilenamePreservingExtension(file.fileName),
        bytes: file.bytes,
        statedMimeType: file.mimeType,
      }),
    ),
  );

const dossierDocuments = async ({
  bytes,
  mimeType,
}: Container): Promise<SlotsResult> => {
  const dossier = await readSignedDossier(bytes, mimeType);
  if (dossier.isErr()) {
    return Result.err(dossier.error);
  }
  return Result.ok(
    dossier.value.documents.map((document): ContainerSlot =>
      document.opaque === true
        ? {
            type: "unavailable",
            fileName: document.fileName,
            folder: null,
            sizeBytes: document.bytes.byteLength,
            reason: "unreadable",
          }
        : part({
            fileName: document.fileName,
            bytes: document.bytes,
            statedMimeType: null,
          }),
    ),
  );
};

/** The signed document a `.p7m` wraps, named after its envelope. */
export const cadesContentCandidate = (
  fileBytes: Uint8Array,
  outerName: string,
): Result<PartCandidate, P7mParseError> => {
  const parsed = parseP7m(fileBytes);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const { bytes } = parsed.value;
  return Result.ok({
    fileName: derivePayloadName(
      outerName,
      detectEmbeddedPayload(bytes).extension,
    ),
    bytes,
    statedMimeType: null,
  });
};

const invoiceAttachments = async ({
  bytes,
  mimeType,
}: Container): Promise<SlotsResult> => {
  const invoice = await readStoredInvoice(bytes, mimeType);
  if (invoice.isErr()) {
    return Result.err(invoice.error);
  }
  const slots: ContainerSlot[] = [];
  for (const attachment of invoice.value?.attachments ?? []) {
    const read = invoiceAttachmentPart(attachment);
    if (read.isErr()) {
      return Result.err(read.error);
    }
    slots.push(part({ ...read.value, statedMimeType: null }));
  }
  return Result.ok(slots);
};

/** An email's attachments at their positions, as its preview lists them. */
const emailAttachments = async ({
  bytes,
  mimeType,
}: Container): Promise<SlotsResult> => {
  const parsed = await parseEmail(bytes.slice().buffer, mimeType);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const listed = new Set(
    buildEmailPreview(parsed.value, {
      citationBlockMode: EMAIL_CITATION_BLOCK_MODE.omit,
    }).attachments,
  );
  return Result.ok(
    parsed.value.attachments.map((attachment, index): ContainerSlot => {
      const fileName = sanitizeFilenamePreservingExtension(
        attachment.fileName ?? "attachment",
      );
      if (!listed.has(index)) {
        return { type: "unlisted" };
      }
      return attachment.bytes.byteLength === 0
        ? {
            type: "unavailable",
            fileName,
            folder: null,
            sizeBytes: 0,
            reason: "unreadable",
          }
        : part({
            fileName,
            bytes: attachment.bytes,
            statedMimeType: attachment.mimeType,
            charset: attachment.charset,
          });
    }),
  );
};

/** The container's parts of one kind, at their positions. */
const containerSlots = async (
  container: Container,
  kind: FilePartKind,
): Promise<SlotsResult> => {
  const kinds: readonly FilePartKind[] =
    FILE_PART_KINDS_BY_FORMAT[container.format];
  if (!kinds.includes(kind)) {
    return Result.ok([]);
  }
  const { format } = container;
  switch (format) {
    case "asicE":
    case "asicS":
      return await asicMembers(container);
    case "zip":
      return await zipFiles(container);
    case "dataBox":
      return dataBoxFiles(container);
    case "eAkta":
    case "zep":
    case "xadesZep":
      return await dossierDocuments(container);
    case "cades": {
      if (kind === FILE_PART_KINDS.content) {
        return cadesContentCandidate(container.bytes, container.fileName).map(
          (candidate) => [part(candidate)],
        );
      }
      // A signed `.xml.p7m` invoice lists its attachments; any other signed
      // document has none.
      const attachments = await invoiceAttachments(container);
      return attachments.isErr() &&
        attachments.error._tag === "DocumentPackageError"
        ? Result.ok([])
        : attachments;
    }
    case "isdoc":
    case "isdocx":
    case "xml":
      return await invoiceAttachments(container);
    case "email":
      return await emailAttachments(container);
    case "uyap":
    case "ofd":
      return Result.ok([]);
    default:
      format satisfies never;
      return panic("Unhandled file part container");
  }
};

/** A part typed and scanned, ready to deliver or to read in turn. */
const typedPart = async (
  candidate: PartCandidate,
): Promise<
  Result<EmbeddedPart, FileScanFailedError | FileScanRejectedError>
> => {
  const { fileName, bytes, statedMimeType, charset = null } = candidate;
  const mimeType = await partMediaType({
    bytes,
    stated: statedMimeType,
    charset,
    fileName,
  });
  const scanned = await scanContainerMember({ fileName, bytes }, mimeType);
  return scanned.isErr()
    ? Result.err(scanned.error)
    : Result.ok({
        fileName: scanned.value.fileName,
        mimeType,
        bytes: new Uint8Array(scanned.value.bytes),
      });
};

type StoredContainer = {
  fileBytes: Uint8Array;
  containerMimeType: string;
  /** The stored file's name, which a signed envelope's document takes. */
  containerName: string;
};

const outermostFirst = (target: FilePart): FilePart[] => [
  ...(target.within === undefined ? [] : outermostFirst(target.within)),
  target,
];

/** The part a container holds at `part`, typed and scanned; null when none. */
export const extractEmbeddedPart = async ({
  fileBytes,
  containerMimeType,
  containerName,
  part: target,
}: StoredContainer & { part: FilePart }): Promise<
  Result<EmbeddedPart | null, EmbeddedPartError>
> => {
  let file: EmbeddedPart = {
    fileName: containerName,
    mimeType: containerMimeType,
    bytes: fileBytes,
  };
  for (const { kind, index } of outermostFirst(target)) {
    const container = containerOf(file);
    if (container === null) {
      return Result.ok(null);
    }
    const slots = await containerSlots(container, kind);
    if (slots.isErr()) {
      return Result.err(slots.error);
    }
    const slot = slots.value.at(index);
    if (slot?.type !== "part") {
      return Result.ok(null);
    }
    const typed = await typedPart(slot.candidate);
    if (typed.isErr()) {
      return Result.err(typed.error);
    }
    file = typed.value;
  }
  return Result.ok(file);
};

/**
 * The files of the part at `part`, which is itself a container, as its own
 * preview would list them: each typed as reading it delivers it, addressed
 * by the path through `part`. Null when the part is not there or holds no
 * parts.
 */
export const listEmbeddedParts = async (
  options: StoredContainer & { part: FilePart },
): Promise<Result<ContainedFile[] | null, EmbeddedPartError>> => {
  const read = await extractEmbeddedPart(options);
  if (read.isErr()) {
    return Result.err(read.error);
  }
  const container = read.value === null ? null : containerOf(read.value);
  if (container === null) {
    return Result.ok(null);
  }
  const files: ContainedFile[] = [];
  for (const kind of FILE_PART_KINDS_BY_FORMAT[container.format]) {
    const slots = await containerSlots(container, kind);
    if (slots.isErr()) {
      return Result.err(slots.error);
    }
    for (const [index, slot] of slots.value.entries()) {
      if (slot.type === "unlisted") {
        continue;
      }
      if (slot.type === "unavailable") {
        files.push({
          fileName: slot.fileName,
          folder: slot.folder,
          sizeBytes: slot.sizeBytes,
          part: null,
          unavailable: slot.reason,
        });
        continue;
      }
      const { candidate } = slot;
      const fileName = sanitizeFilenamePreservingExtension(candidate.fileName);
      files.push({
        fileName: candidate.fileName,
        folder: slot.folder,
        sizeBytes: candidate.bytes.byteLength,
        part: {
          part: filePartId({ kind, index, within: options.part }),
          fileName,
          mediaType: await partMediaType({
            bytes: candidate.bytes,
            stated: candidate.statedMimeType,
            charset: candidate.charset ?? null,
            fileName: candidate.fileName,
          }),
          sizeBytes: candidate.bytes.byteLength,
        },
        unavailable: null,
        // A text part decodes with the charset its container declares.
        charset: candidate.charset ?? null,
      });
    }
  }
  return Result.ok(files);
};
