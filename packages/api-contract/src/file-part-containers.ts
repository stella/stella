import { documentFormat } from "./document-format";
import { resolveEmailMimeType } from "./email-mime-types";
import {
  FILE_PART_KINDS,
  FILE_PART_MAX_DEPTH,
  filePartDepth,
  type FilePartDescriptor,
  type FilePartKind,
  isFilePartTextMediaType,
  parseFilePartId,
} from "./file-parts";
import {
  LEGAL_FILE_FORMATS,
  type LegalFileFormatKind,
} from "./legal-file-formats";

const { attachment, content, document, member, message } = FILE_PART_KINDS;

/**
 * Every stored format and the kinds of part its files have, in the order
 * its parts are listed. A format with none has `[]`. The server reads each
 * kind with its own reader; this table is what lets a client tell a part
 * that is itself a container from any other file.
 */
export const FILE_PART_KINDS_BY_FORMAT = {
  // A signed `.xml.p7m` invoice lists its attachments beside its document.
  cades: [content, attachment],
  asicE: [member],
  asicS: [member],
  eAkta: [document],
  zep: [document],
  xadesZep: [document],
  dataBox: [attachment],
  isdoc: [attachment],
  isdocx: [attachment],
  xml: [attachment],
  uyap: [],
  ofd: [],
  // A signature file's text is read whole; it has no parts of its own.
  cadesDetached: [],
  xades: [],
  zip: [member],
  mbox: [message],
  pst: [message],
  email: [attachment],
} as const satisfies Record<
  LegalFileFormatKind | "email",
  readonly FilePartKind[]
>;

export type FilePartContainerFormat = keyof typeof FILE_PART_KINDS_BY_FORMAT;

const CONTAINER_FORMATS = [
  ...LEGAL_FILE_FORMATS.map(({ kind }) => kind),
  "email",
] as const satisfies readonly FilePartContainerFormat[];

/**
 * The format of a file whose parts open in turn, from its media type and
 * name: a signed envelope, a signed or ASiC container, a data-box message,
 * an invoice, a ZIP archive, a mailbox or an email. Null for a file without
 * parts.
 */
export const filePartContainerFormat = (
  mediaType: string | null | undefined,
  fileName: string | null | undefined,
): FilePartContainerFormat | null => {
  const { kind } = documentFormat(mediaType, fileName);
  const format =
    resolveEmailMimeType({ mimeType: mediaType, fileName }) === null
      ? CONTAINER_FORMATS.find((candidate) => candidate === kind)
      : "email";
  return format !== undefined && FILE_PART_KINDS_BY_FORMAT[format].length > 0
    ? format
    : null;
};

/**
 * Whether a part opens to the files inside it rather than as a file: it is
 * a container (an email, an archive, a data-box message, a signed file), it
 * is not text a reader shows as itself, and its own parts would still sit
 * within the deepest path a part may have.
 */
export const opensToFilesInside = ({
  fileName,
  mediaType,
  part,
}: Pick<FilePartDescriptor, "fileName" | "mediaType" | "part">): boolean => {
  const address = parseFilePartId(part);
  return (
    address !== null &&
    filePartDepth(address) < FILE_PART_MAX_DEPTH &&
    !isFilePartTextMediaType(mediaType) &&
    filePartContainerFormat(mediaType, fileName) !== null
  );
};
