/**
 * Reads one file inside a stored container in the extraction worker: an
 * ASiC or BDOC member, or a data-box message's file. The part is scanned
 * exactly as an upload of its bytes would be before it leaves the worker.
 */
import { Result } from "better-result";

import { ASIC_FILE_FORMATS } from "@stll/api-contract/asic-file-formats";
import { FILE_PART_KINDS, type FilePart } from "@stll/api-contract/file-parts";
import { DATA_BOX_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";

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
import {
  containerMemberMimeType,
  scanContainerMember,
} from "@/api/lib/files/asic-preview-worker";
import type { EmbeddedPart } from "@/api/lib/files/embedded-part-protocol";
import { OPAQUE_EMBEDDED_MIME_TYPE } from "@/api/lib/files/embedded-payload-format";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

type EmbeddedPartError =
  | AsicParseError
  | DataBoxMessageParseError
  | FileScanFailedError
  | FileScanRejectedError;

type Candidate = {
  fileName: string;
  bytes: Uint8Array;
  statedMimeType?: string;
};

const candidateOf = async (
  fileBytes: Uint8Array,
  containerMimeType: string,
  { kind, index }: FilePart,
): Promise<
  Result<Candidate | null, AsicParseError | DataBoxMessageParseError>
> => {
  const asic = ASIC_FILE_FORMATS.find(
    ({ mimeType }) => mimeType === containerMimeType,
  );
  if (asic !== undefined && kind === FILE_PART_KINDS.member) {
    const container = await readAsicContainer(fileBytes, asic.mimeType);
    return container.isErr()
      ? Result.err(container.error)
      : Result.ok(container.value.members.at(index) ?? null);
  }
  if (
    containerMimeType === DATA_BOX_FILE_FORMAT.mimeType &&
    kind === FILE_PART_KINDS.attachment
  ) {
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
  }
  return Result.ok(null);
};

/** The part a container holds at `part`, scanned; null when it holds none. */
export const extractEmbeddedPart = async ({
  fileBytes,
  containerMimeType,
  part,
}: {
  fileBytes: Uint8Array;
  containerMimeType: string;
  part: FilePart;
}): Promise<Result<EmbeddedPart | null, EmbeddedPartError>> => {
  const candidate = await candidateOf(fileBytes, containerMimeType, part);
  if (candidate.isErr()) {
    return Result.err(candidate.error);
  }
  if (candidate.value === null) {
    return Result.ok(null);
  }
  const { fileName, bytes, statedMimeType } = candidate.value;
  // The bytes name the type; a type they do not reveal falls back to the
  // container's statement, else stays opaque.
  const detected = await containerMemberMimeType(bytes);
  const mimeType =
    detected === OPAQUE_EMBEDDED_MIME_TYPE
      ? (statedMimeType ?? OPAQUE_EMBEDDED_MIME_TYPE)
      : detected;
  const scanned = await scanContainerMember({ fileName, bytes }, mimeType);
  return scanned.isErr()
    ? Result.err(scanned.error)
    : Result.ok({
        fileName: scanned.value.fileName,
        mimeType,
        bytes: new Uint8Array(scanned.value.bytes),
      });
};
