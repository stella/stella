/**
 * A ZIP archive's preview, read in the extraction worker: every file it
 * holds, typed and scanned as its part link delivers it, with the text of
 * readable files within one character budget, in archive order.
 */
import { Result, type UnhandledException } from "better-result";

import {
  FILE_PART_KINDS,
  filePartId,
  type FilePartUnavailableReason,
} from "@stll/api-contract/file-parts";
import type { ZipArchivePreview } from "@stll/api-contract/zip-archive";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import {
  type ContainerMember,
  readContainerMemberTexts,
  type ReadMemberText,
} from "@/api/lib/files/asic-preview-worker";
import type { DocumentPackageError } from "@/api/lib/files/document-archive";
import {
  readZipArchive,
  readZipArchiveFile,
} from "@/api/lib/files/zip-archive";
import { zipArchiveText } from "@/api/lib/files/zip-archive-text";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

type ArchiveRow = {
  readonly fileName: string;
  readonly folder: string | null;
  readonly sizeBytes: number;
  readonly unavailable: FilePartUnavailableReason | null;
  /** The file's bytes, when it opens. */
  readonly member: ContainerMember | null;
};

export const extractZipArchivePreview = async ({
  fileBytes,
  maxChars,
  readText,
}: {
  fileBytes: Uint8Array;
  maxChars: number;
  readText: ReadMemberText;
}): Promise<
  Result<
    ZipArchivePreview,
    | DocumentPackageError
    | FileScanFailedError
    | FileScanRejectedError
    | UnhandledException
  >
> => {
  const archive = await readZipArchive(fileBytes);
  if (archive.isErr()) {
    return Result.err(archive.error);
  }
  const rows = archive.value.map((file): ArchiveRow => {
    // A stated name is shown, never used as a path; it is listed as the safe
    // name its part link delivers it under.
    const fileName = sanitizeFilenamePreservingExtension(file.fileName);
    const row = {
      fileName,
      folder: file.folder,
      sizeBytes: file.sizeBytes,
    };
    if (file.unavailable !== null) {
      return { ...row, unavailable: file.unavailable, member: null };
    }
    const read = readZipArchiveFile(file);
    return read.isErr()
      ? { ...row, unavailable: "unreadable", member: null }
      : {
          ...row,
          unavailable: null,
          member: { fileName, bytes: new Uint8Array(read.value) },
        };
  });

  // Reserve room for every path, heading and potential clipping notice.
  const layoutChars =
    zipArchiveText({
      files: rows.map(({ fileName, folder }) => ({
        fileName,
        folder,
        status: "truncated",
        text: "",
        unavailable: null,
      })),
    }).length + rows.length;
  const members = rows.flatMap(({ member }) =>
    member === null ? [] : [member],
  );
  const texts = await readContainerMemberTexts({
    members,
    maxChars: Math.max(0, maxChars - layoutChars),
    readText,
  });
  if (texts.isErr()) {
    return Result.err(texts.error);
  }
  const readings = texts.value.values();
  const files: ZipArchivePreview["files"] = rows.map((row, index) => {
    const listed = {
      fileName: row.fileName,
      folder: row.folder,
      sizeBytes: row.sizeBytes,
    };
    const reading = row.member === null ? undefined : readings.next().value;
    if (reading === undefined) {
      return {
        ...listed,
        part: null,
        unavailable: row.unavailable ?? "unreadable",
        status: "unavailable",
        text: "",
        textFormat: "plain",
      };
    }
    return {
      ...listed,
      part: {
        part: filePartId({ kind: FILE_PART_KINDS.member, index }),
        fileName: row.fileName,
        mediaType: reading.mediaType,
        sizeBytes: reading.sizeBytes,
      },
      unavailable: null,
      status: reading.status,
      text: reading.text,
      textFormat: reading.textFormat,
    };
  });
  return Result.ok({ files } satisfies ZipArchivePreview);
};
