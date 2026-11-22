/**
 * Reads one file inside a stored container in the extraction worker: an
 * ASiC or BDOC member, a data-box message's file, a signed container's
 * document, the document a signed `.p7m` wraps, or an invoice's attachment.
 * The part is typed by `partMediaType`, as its file's preview lists it, and
 * scanned exactly as an upload of its bytes would be before it leaves the
 * worker.
 */
import { panic, Result } from "better-result";

import { ASIC_FILE_FORMATS } from "@stll/api-contract/asic-file-formats";
import { FILE_PART_KINDS, type FilePart } from "@stll/api-contract/file-parts";
import {
  LEGAL_FILE_FORMATS,
  type LegalFileFormatKind,
} from "@stll/api-contract/legal-file-formats";

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
import type { EmbeddedPart } from "@/api/lib/files/embedded-part-protocol";
import { detectEmbeddedPayload } from "@/api/lib/files/embedded-payload-format";
import { type P7mParseError, parseP7m } from "@/api/lib/files/p7m";
import { partMediaType } from "@/api/lib/files/part-media-type";
import {
  readSignedDossier,
  type SignedDossierReadError,
} from "@/api/lib/files/signed-dossier-worker";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

type EmbeddedPartError =
  | AsicParseError
  | DataBoxMessageParseError
  | DocumentPackageError
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
};

type CandidateResult = Result<PartCandidate | null, EmbeddedPartError>;

const asicMember = async (
  fileBytes: Uint8Array,
  containerMimeType: string,
  index: number,
): Promise<CandidateResult> => {
  const format = ASIC_FILE_FORMATS.find(
    ({ mimeType }) => mimeType === containerMimeType,
  );
  if (format === undefined) {
    return Result.ok(null);
  }
  const container = await readAsicContainer(fileBytes, format.mimeType);
  if (container.isErr()) {
    return Result.err(container.error);
  }
  const member = container.value.members.at(index);
  return Result.ok(
    member === undefined
      ? null
      : {
          fileName: member.fileName,
          bytes: member.bytes,
          statedMimeType: null,
        },
  );
};

const dataBoxFile = (fileBytes: Uint8Array, index: number): CandidateResult => {
  const message = parseDataBoxMessage(fileBytes);
  if (message.isErr()) {
    return Result.err(message.error);
  }
  const file = message.value.files.at(index);
  return Result.ok(
    file === undefined
      ? null
      : {
          fileName: sanitizeFilenamePreservingExtension(file.fileName),
          bytes: file.bytes,
          statedMimeType: file.mimeType,
        },
  );
};

const dossierDocument = async (
  fileBytes: Uint8Array,
  containerMimeType: string,
  index: number,
): Promise<CandidateResult> => {
  const dossier = await readSignedDossier(fileBytes, containerMimeType);
  if (dossier.isErr()) {
    return Result.err(dossier.error);
  }
  const document = dossier.value.documents.at(index);
  return Result.ok(
    document === undefined || document.opaque === true
      ? null
      : {
          fileName: document.fileName,
          bytes: document.bytes,
          statedMimeType: null,
        },
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

const invoiceAttachment = async (
  fileBytes: Uint8Array,
  containerMimeType: string,
  index: number,
): Promise<CandidateResult> => {
  const invoice = await readStoredInvoice(fileBytes, containerMimeType);
  if (invoice.isErr()) {
    return Result.err(invoice.error);
  }
  const attachment = invoice.value?.attachments.at(index);
  if (attachment === undefined) {
    return Result.ok(null);
  }
  return invoiceAttachmentPart(attachment).map(({ fileName, bytes }) => ({
    fileName,
    bytes,
    statedMimeType: null,
  }));
};

const candidateOf = async ({
  fileBytes,
  containerMimeType,
  containerName,
  part: { kind, index },
}: {
  fileBytes: Uint8Array;
  containerMimeType: string;
  containerName: string;
  part: FilePart;
}): Promise<CandidateResult> => {
  const format: LegalFileFormatKind | undefined = LEGAL_FILE_FORMATS.find(
    ({ mimeType }) => mimeType === containerMimeType,
  )?.kind;
  switch (format) {
    case "asicE":
    case "asicS":
      return kind === FILE_PART_KINDS.member
        ? await asicMember(fileBytes, containerMimeType, index)
        : Result.ok(null);
    case "dataBox":
      return kind === FILE_PART_KINDS.attachment
        ? dataBoxFile(fileBytes, index)
        : Result.ok(null);
    case "eAkta":
    case "zep":
    case "xadesZep":
      return kind === FILE_PART_KINDS.document
        ? await dossierDocument(fileBytes, containerMimeType, index)
        : Result.ok(null);
    case "cades":
      if (kind === FILE_PART_KINDS.content) {
        return index === 0
          ? cadesContentCandidate(fileBytes, containerName)
          : Result.ok(null);
      }
      // A signed `.xml.p7m` invoice lists its attachments.
      return kind === FILE_PART_KINDS.attachment
        ? await invoiceAttachment(fileBytes, containerMimeType, index)
        : Result.ok(null);
    case "isdoc":
    case "isdocx":
    case "xml":
      return kind === FILE_PART_KINDS.attachment
        ? await invoiceAttachment(fileBytes, containerMimeType, index)
        : Result.ok(null);
    case "uyap":
    case "ofd":
    case undefined:
      return Result.ok(null);
    default:
      format satisfies never;
      return panic("Unhandled legal file format");
  }
};

/** The part a container holds at `part`, typed and scanned; null when none. */
export const extractEmbeddedPart = async (options: {
  fileBytes: Uint8Array;
  containerMimeType: string;
  /** The stored file's name, which a signed envelope's document takes. */
  containerName: string;
  part: FilePart;
}): Promise<Result<EmbeddedPart | null, EmbeddedPartError>> => {
  const candidate = await candidateOf(options);
  if (candidate.isErr()) {
    return Result.err(candidate.error);
  }
  if (candidate.value === null) {
    return Result.ok(null);
  }
  const { fileName, bytes, statedMimeType } = candidate.value;
  const mimeType = await partMediaType({
    bytes,
    stated: statedMimeType,
    charset: null,
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
