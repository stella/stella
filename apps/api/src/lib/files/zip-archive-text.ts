import { panic } from "better-result";

import type { FilePartUnavailableReason } from "@stll/api-contract/file-parts";
import type { ZipArchivePreview } from "@stll/api-contract/zip-archive";

/** What the text shows of a file: where it sits and its reading. */
type FileReading = Pick<
  ZipArchivePreview["files"][number],
  "fileName" | "folder" | "status" | "text" | "unavailable"
>;

const UNAVAILABLE_TEXT = {
  encrypted: "The file is encrypted, so it was not read or scanned.",
  unsupported:
    "The file is compressed with a method that is not supported, " +
    "so it was not read or scanned.",
  link: "The file is a link to another path and is not followed.",
  tooLarge: "The file is too large to read.",
  unreadable: "The file is damaged.",
} as const satisfies Record<FilePartUnavailableReason, string>;

const fileText = ({ status, text, unavailable }: FileReading): string => {
  if (unavailable !== null) {
    return UNAVAILABLE_TEXT[unavailable];
  }
  switch (status) {
    case "readable":
      return text;
    case "truncated":
      return text
        ? `${text}\nFile text was truncated.`
        : "File text was truncated.";
    case "unavailable":
      return "File text unavailable.";
    default:
      status satisfies never;
      return panic("Unknown archive file text status");
  }
};

/**
 * An archive's text for search, chat, workflows and agents: each file under
 * its path in the archive, in the archive's order.
 */
export const zipArchiveText = ({
  files,
  maxChars,
}: {
  files: readonly FileReading[];
  /** The most characters the text may hold; unbounded when absent. */
  maxChars?: number;
}): string => {
  const text = [
    "ZIP archive.",
    ...files.map(
      (file) =>
        `File: ${file.folder === null ? "" : `${file.folder}/`}${file.fileName}\n${fileText(file)}`,
    ),
  ].join("\n\n");
  return maxChars === undefined ? text : text.slice(0, maxChars);
};
