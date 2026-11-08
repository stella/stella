import type { DesktopRunnerAttachment } from "@stll/api-contract/desktop-runner";

import type {
  HarnessImageMediaType,
  HarnessInputFile,
  HarnessInputFileType,
} from "../harness/adapter";
import type { HarnessTranscriptMessage } from "../harness/transcript-handoff";
import { readWorkspaceFile, type WorkspaceFileRefusal } from "./workspace-file";

/**
 * Which of a run's copied attachments its harness hands the model as input,
 * read from the copies `copyAttachments` just made. Only files the turn's own
 * user message names go: a resumed session already holds earlier ones, and
 * the history names them as paths. A file that does not fit stays a path the
 * agent can open; it never fails the turn.
 *
 * The limits follow what the providers behind both CLIs take, so a request
 * the harness sends is not refused for its files.
 */

/**
 * Claude refuses an image whose base64 is over 5 MiB; this is that size
 * before encoding. Codex's models take larger ones, but one limit keeps a
 * conversation portable between the two.
 */
export const MAX_INPUT_IMAGE_BYTES = (5 * 1024 * 1024 * 3) / 4;
/**
 * A PDF and the whole turn. Claude's API refuses a request over 32 MB, and a
 * session sends its earlier files again with every turn, so one turn's files
 * take about a third of that once encoded. They also stay below the 16 MiB
 * line the adapters read back when Codex echoes the user message.
 */
const MAX_INPUT_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_INPUT_TURN_BYTES = 8 * 1024 * 1024;
/** Claude reads at most 100 PDF pages per request. */
export const MAX_INPUT_PDF_PAGES = 100;
/** Beyond 20 images Claude shrinks the largest size it accepts. */
export const MAX_INPUT_FILES = 20;

/** Why a named file stays a path only; logged without its name. */
type InputFileSkip =
  | WorkspaceFileRefusal
  | "unsupported_type"
  | "not_accepted"
  | "pdf_pages_unknown"
  | "turn_full";

type ReadInputFilesOptions = {
  attachments: readonly DesktopRunnerAttachment[];
  workspaceDir: string;
  /** The user message that starts the turn. */
  request: HarnessTranscriptMessage | undefined;
  /** What the harness hands its model; any other file stays a path. */
  accepts: readonly HarnessInputFileType[];
};

type InputFiles = {
  files: HarnessInputFile[];
  skipped: InputFileSkip[];
};

const requestText = (request: HarnessTranscriptMessage | undefined) => {
  if (request?.role !== "user" || request.content === null) {
    return "";
  }
  if (typeof request.content === "string") {
    return request.content;
  }
  return request.content
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("\n");
};

/** The attachments the message names, in the order it names them. */
const namedIn = (
  attachments: readonly DesktopRunnerAttachment[],
  text: string,
) =>
  attachments
    .map((attachment) => ({ attachment, at: text.indexOf(attachment.path) }))
    .filter(({ at }) => at !== -1)
    .toSorted((left, right) => left.at - right.at)
    .map(({ attachment }) => attachment);

type Sniffed =
  { type: "image"; mediaType: HarnessImageMediaType } | { type: "pdf" };

/** The bytes of a signature written in ASCII. */
const ascii = (text: string) => [...new TextEncoder().encode(text)];

const PNG_SIGNATURE = [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

const startsWith = (
  bytes: Uint8Array,
  at: number,
  expected: readonly number[],
) =>
  expected.length <= bytes.length - at &&
  expected.every((byte, index) => bytes[at + index] === byte);

/**
 * The file's type from its first bytes, never from its name: the agent may
 * have rewritten a copy, and a model refuses a file that is not what it says.
 */
const sniff = (bytes: Uint8Array): Sniffed | null => {
  if (startsWith(bytes, 0, PNG_SIGNATURE)) {
    return { type: "image", mediaType: "image/png" };
  }
  if (startsWith(bytes, 0, JPEG_SIGNATURE)) {
    return { type: "image", mediaType: "image/jpeg" };
  }
  if (
    startsWith(bytes, 0, ascii("GIF87a")) ||
    startsWith(bytes, 0, ascii("GIF89a"))
  ) {
    return { type: "image", mediaType: "image/gif" };
  }
  if (
    startsWith(bytes, 0, ascii("RIFF")) &&
    startsWith(bytes, 8, ascii("WEBP"))
  ) {
    return { type: "image", mediaType: "image/webp" };
  }
  if (startsWith(bytes, 0, ascii("%PDF-"))) {
    return { type: "pdf" };
  }
  return null;
};

/** A page dictionary's type entry, not the page tree's `/Pages`. */
const PAGE_OBJECT = /\/Type\s*\/Page(?=[\s/<>[\]()%{}]|$)/gu;
/** Objects the scan cannot see into: compressed or encrypted. */
const HIDDEN_OBJECTS = /\/(?:ObjStm|Encrypt)(?=[\s/<>[\]()%{}]|$)/u;

/**
 * Pages of a PDF from its visible page objects, `null` when they may be
 * hidden. Never more than the PDF has: rewritten pages of an updated file
 * count twice, which only keeps it a path sooner. Following t3code (MIT),
 * nothing is decompressed to enforce a provider's limit.
 */
const pdfPages = (bytes: Uint8Array): number | null => {
  const text = Buffer.from(bytes).toString("latin1");
  if (HIDDEN_OBJECTS.test(text)) {
    return null;
  }
  const pages = text.match(PAGE_OBJECT)?.length ?? 0;
  return pages === 0 ? null : pages;
};

const LARGEST_INPUT_BYTES = Math.max(
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_PDF_BYTES,
);

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const readInputFiles = async ({
  attachments,
  workspaceDir,
  request,
  accepts,
}: ReadInputFilesOptions): Promise<InputFiles> => {
  const files: HarnessInputFile[] = [];
  const skipped: InputFileSkip[] = [];
  let turnBytes = 0;
  let pdfPageCount = 0;
  for (const attachment of namedIn(attachments, requestText(request))) {
    // await-in-loop: one file in memory at a time.
    const read = await readWorkspaceFile(
      workspaceDir,
      attachment.path,
      LARGEST_INPUT_BYTES,
    );
    if (read.type === "refused") {
      skipped.push(read.reason);
      continue;
    }
    const { bytes } = read;
    const sniffed = sniff(bytes);
    if (sniffed === null) {
      skipped.push("unsupported_type");
      continue;
    }
    if (!accepts.includes(sniffed.type)) {
      skipped.push("not_accepted");
      continue;
    }
    const limit =
      sniffed.type === "image" ? MAX_INPUT_IMAGE_BYTES : MAX_INPUT_PDF_BYTES;
    if (bytes.length > limit) {
      skipped.push("too_large");
      continue;
    }
    const pages = sniffed.type === "pdf" ? pdfPages(bytes) : 0;
    if (pages === null) {
      skipped.push("pdf_pages_unknown");
      continue;
    }
    if (
      files.length >= MAX_INPUT_FILES ||
      turnBytes + bytes.length > MAX_INPUT_TURN_BYTES ||
      pdfPageCount + pages > MAX_INPUT_PDF_PAGES
    ) {
      skipped.push("turn_full");
      continue;
    }
    turnBytes += bytes.length;
    pdfPageCount += pages;
    files.push(
      sniffed.type === "image"
        ? { type: "image", mediaType: sniffed.mediaType, base64: base64(bytes) }
        : { type: "pdf", base64: base64(bytes) },
    );
  }
  return { files, skipped };
};
