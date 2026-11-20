/**
 * Isolated extraction worker.
 *
 * Runs as a standalone Bun subprocess. Receives the MIME type
 * as a CLI argument and raw file bytes on stdin; writes
 * extracted plain text to stdout.
 *
 * Process isolation keeps parser crashes and hangs out of the API
 * event loop. This is not an OS security sandbox: parsers retain the
 * worker process's permissions. The parent enforces a hard timeout.
 *
 * Usage:  bun run extraction-worker.ts <mimeType>
 *   stdin  → raw file bytes
 *   stdout → extracted text (empty if none)
 *   stderr → error messages (captured by parent), plus one line per
 *            email attachment whose text could not be extracted
 *   exit 0 = success, exit 1 = extraction error
 */

import { toMarkdownBytes } from "@firecrawl/anydoc";
import { panic, Result, type UnhandledException } from "better-result";
import type * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";
import type { cadesPreviewSchema } from "@stll/api-contract/cades";
import { legalFileFormat } from "@stll/api-contract/document-format";
import {
  EMAIL_MIME_TYPES,
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
} from "@stll/api-contract/email-mime-types";
import {
  LEGAL_FILE_FORMATS,
  type LegalFileFormatKind,
} from "@stll/api-contract/legal-file-formats";
import { sanitizeErrorForOutput, sanitizeQueryErrorText } from "@stll/errors";
import { extractDocxText, FolioDocxReviewer } from "@stll/folio-core/server";
import { load } from "@stll/html";

import { dataBoxDocumentText } from "@/api/lib/email/correspondence/data-box/document-text";
import { DATA_BOX_PREVIEW_MODE } from "@/api/lib/email/correspondence/data-box/preview-contract";
import { extractDataBoxPreview } from "@/api/lib/email/correspondence/data-box/preview-worker";
import { parseDataBoxDocument } from "@/api/lib/email/correspondence/data-box/zfo";
import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import type { AsicParseError } from "@/api/lib/files/asic-container";
import { asicDocumentText } from "@/api/lib/files/asic-document-text";
import {
  ASIC_PREVIEW_WORKER_EXIT,
  ASIC_PREVIEW_WORKER_MODE,
} from "@/api/lib/files/asic-preview-protocol";
import { extractAsicPreview } from "@/api/lib/files/asic-preview-worker";
import { cadesDocumentText } from "@/api/lib/files/cades-document-text";
import {
  CADES_WORKER_EXIT,
  CADES_WORKER_MODE,
  type CadesWorkerMode,
} from "@/api/lib/files/cades-preview-protocol";
import { scanCadesPayload } from "@/api/lib/files/cades-preview-worker";
import {
  type EmailAttachment,
  type EmailParseError,
  parsedEmailToText,
  parseEmail,
} from "@/api/lib/files/email-to-html";
import type { P7mParseError } from "@/api/lib/files/p7m";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  canExtractMimeType,
  isDirectTextMimeType,
  isOfficeDocumentMimeType,
  normalizeMimeType,
} from "@/api/lib/search/extractable-mime-types";
import {
  classifyAttachmentError,
  formatAttachmentIssue,
  STANDALONE_ATTACHMENT_MODE,
} from "@/api/lib/search/extraction-worker-attachments";
import {
  formatWorkerErrorLine,
  getWorkerErrorClass,
} from "@/api/lib/search/extraction-worker-error";
import { writeWorkerStdout } from "@/api/lib/subprocess";
import {
  DOC_MIME_TYPE,
  DOCM_MIME_TYPE,
  DOCX_MIME_TYPE,
  EPUB_MIME_TYPE,
  ODP_MIME_TYPE,
  ODS_MIME_TYPE,
  ODT_MIME_TYPE,
  PDF_MIME_TYPE,
  PPSX_MIME_TYPE,
  PPT_MIME_TYPE,
  PPTX_MIME_TYPE,
  RTF_MIME_TYPE,
  XLS_MIME_TYPE,
  XLSB_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

const EMAIL_ATTACHMENT_MAX_COUNT = 25;
const EMAIL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const EMAIL_MAX_NESTING_DEPTH = 2;

const ATTACHMENT_EXTENSION_MIME_TYPES: Record<string, string> = {
  csv: "text/csv",
  doc: DOC_MIME_TYPE,
  docm: DOCM_MIME_TYPE,
  docx: DOCX_MIME_TYPE,
  eml: EML_MIME_TYPE,
  epub: EPUB_MIME_TYPE,
  htm: "text/html",
  html: "text/html",
  ics: "text/calendar",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  msg: MSG_MIME_TYPE,
  odp: ODP_MIME_TYPE,
  ods: ODS_MIME_TYPE,
  odt: ODT_MIME_TYPE,
  pdf: PDF_MIME_TYPE,
  ppsx: PPSX_MIME_TYPE,
  ppt: PPT_MIME_TYPE,
  pptx: PPTX_MIME_TYPE,
  rtf: RTF_MIME_TYPE,
  text: "text/plain",
  txt: "text/plain",
  xls: XLS_MIME_TYPE,
  xlsb: XLSB_MIME_TYPE,
  xlsx: XLSX_MIME_TYPE,
};

/**
 * PDFs convert through anydoc like the office formats. A scanned or
 * image-only PDF is not an extraction failure: anydoc rejects it with
 * `code: "unsupported"` and an OCR marker in the message, and the caller
 * treats the resulting empty text as the signal to request OCR. The
 * marker is pinned by fixture tests so an anydoc upgrade that rewords it
 * fails loudly instead of silently converting scans into hard errors.
 */
const isOcrRequiredError = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  error.code === "unsupported" &&
  error.message.includes("OCR is required");

const extractPdfMarkdown = async (
  pdfBytes: Uint8Array,
): Promise<string | null> => {
  try {
    return normalizeExtractedText(await toMarkdownBytes(Buffer.from(pdfBytes)));
  } catch (error) {
    if (isOcrRequiredError(error)) {
      return null;
    }
    throw error;
  }
};

/**
 * Office formats go through anydoc, which parses each format into a
 * shared document model and serializes Markdown from it.
 *
 * The MIME type is not forwarded as a format hint: it originates
 * from the upload and is routinely generic or wrong, while anydoc
 * detects the format from content markers in the bytes themselves.
 * Detection failure surfaces as a throw, which the caller reports
 * as an extraction error.
 */
const extractOfficeDocumentMarkdown = async (
  fileBytes: Uint8Array,
): Promise<string> =>
  normalizeExtractedText(await toMarkdownBytes(Buffer.from(fileBytes)));

const extractDirectText = (fileBytes: Uint8Array, mimeType: string): string => {
  const text = new TextDecoder().decode(fileBytes);
  if (normalizeMimeType(mimeType) !== "text/html") {
    return normalizeExtractedText(text);
  }

  const $ = load(text);
  $("script, style, iframe, frame, frameset, object, embed, applet").remove();
  $("br").replaceWith("\n");
  $("p, div, tr, li, blockquote, h1, h2, h3, h4, h5, h6").append("\n");
  return normalizeExtractedText($.root().text());
};

const joinDocxContentWithReservedNotes = ({
  content,
  maxChars,
  notes,
}: {
  content: string;
  maxChars: number;
  notes: string;
}): string => {
  if (content.trim().length === 0) {
    return notes;
  }
  if (notes.trim().length === 0) {
    return content;
  }

  const separator = "\n";
  if (notes.length >= maxChars) {
    return notes.slice(0, maxChars);
  }

  const contentMaxChars = maxChars - notes.length - separator.length;
  if (contentMaxChars <= 0) {
    return notes.slice(0, maxChars);
  }

  return `${content.slice(0, contentMaxChars)}${separator}${notes}`;
};

const extractEmailPlaintext = async ({
  fileBytes,
  maxChars,
  mimeType,
  nestingDepth,
}: {
  fileBytes: Uint8Array;
  maxChars: number;
  mimeType: string;
  nestingDepth: number;
}): Promise<Result<string | null, EmailParseError>> => {
  const parsedResult = await parseEmail(toArrayBuffer(fileBytes), mimeType);
  if (parsedResult.isErr()) {
    return parsedResult;
  }
  const parsed = parsedResult.value;
  const parts: string[] = [];
  const body = parsedEmailToText(parsed);
  if (body) {
    parts.push(body);
  }

  if (nestingDepth >= EMAIL_MAX_NESTING_DEPTH) {
    return Result.ok(joinExtractedParts(parts, maxChars));
  }

  for (const attachment of parsed.attachments
    .filter((item) => !isSkippedInlineImage(item))
    .slice(0, EMAIL_ATTACHMENT_MAX_COUNT)) {
    if (attachment.bytes.byteLength > EMAIL_ATTACHMENT_MAX_BYTES) {
      continue;
    }

    const attachmentMimeType = resolveAttachmentMimeType(attachment);
    if (!attachmentMimeType || !canExtractMimeType(attachmentMimeType)) {
      continue;
    }

    const text = await extractAttachmentPlaintext({
      bytes: attachment.bytes,
      maxChars,
      mimeType: attachmentMimeType,
      nestingDepth: nestingDepth + 1,
    });
    if (!text) {
      continue;
    }

    parts.push(
      [
        `Attachment: ${attachment.fileName ?? "unnamed"} (${attachmentMimeType})`,
        text,
      ].join("\n"),
    );
  }

  return Result.ok(joinExtractedParts(parts, maxChars));
};

const extractAttachmentPlaintext = async ({
  bytes,
  maxChars,
  mimeType,
  nestingDepth,
}: {
  bytes: Uint8Array;
  maxChars: number;
  mimeType: string;
  nestingDepth: number;
}): Promise<string | null> => {
  const result = (
    await Result.tryPromise({
      try: async () =>
        await extract({ fileBytes: bytes, mimeType, maxChars, nestingDepth }),
      catch: (error) => error,
    })
  ).andThen((extracted) => extracted);
  if (result.isErr()) {
    // The email keeps its other text; the parent reads this line back to
    // record the attachment that did not contribute any.
    process.stderr.write(
      sanitizeQueryErrorText(
        formatAttachmentIssue(classifyAttachmentError(result.error, mimeType)),
      ),
    );
    return null;
  }
  return result.value;
};

type LegalTextReadOptions = {
  fileBytes: Uint8Array;
  mimeType: string;
  maxChars: number;
  nestingDepth: number;
  includeContainerAttachments: boolean;
};

type LegalTextReadError =
  | AsicParseError
  | FileScanFailedError
  | FileScanRejectedError
  | P7mParseError
  | UnhandledException;

const extractDataBoxText = async ({
  fileBytes,
  maxChars,
  nestingDepth,
  includeContainerAttachments,
}: LegalTextReadOptions): Promise<
  Result<string | null, LegalTextReadError>
> => {
  // Each filed attachment has its own matter document and searchable text.
  const document = parseDataBoxDocument(fileBytes);
  if (document.isErr()) {
    return Result.ok(null);
  }
  let text = dataBoxDocumentText(document.value);
  if (includeContainerAttachments && document.value.kind === "message") {
    const { scanUpload } = await import("@/api/lib/file-scan/scan-upload");
    for (const file of document.value.files) {
      const mimeType = resolveAttachmentMimeType(file) ?? file.mimeType;
      const scanned = await scanUpload({
        bytes: file.bytes,
        fileName: sanitizeFilename(file.fileName),
        declaredMimeType: mimeType,
      });
      if (scanned.isErr()) {
        return Result.err(scanned.error);
      }
      const heading = `

Attachment: ${file.fileName}
`;
      const remainingChars = maxChars - text.length - heading.length;
      if (remainingChars <= 0) {
        continue;
      }
      const content = canExtractMimeType(mimeType)
        ? await extractAttachmentPlaintext({
            bytes: new Uint8Array(scanned.value.bytes),
            maxChars: remainingChars,
            mimeType,
            nestingDepth: nestingDepth + 1,
          })
        : null;
      text += heading + (content ?? "Attachment text unavailable.");
    }
  }
  return Result.ok(text);
};

const extractCadesText = async ({
  fileBytes,
  maxChars,
}: LegalTextReadOptions): Promise<
  Result<string | null, LegalTextReadError | EmailParseError>
> => {
  const scanned = await scanCadesPayload(fileBytes, "");
  if (scanned.isErr()) {
    return Result.err(scanned.error);
  }
  const { file, layers } = scanned.value;
  const content = await extractEmbeddedPayloadText(file, maxChars);
  if (content.isErr()) {
    return content;
  }
  return Result.ok(cadesDocumentText({ layers, text: content.value ?? "" }));
};

const extractAsicText = async ({
  fileBytes,
  mimeType,
  maxChars,
}: LegalTextReadOptions): Promise<
  Result<string | null, LegalTextReadError | EmailParseError>
> => {
  const preview = await extractAsicPreview({
    fileBytes,
    expectedMimeType: mimeType,
    maxChars,
    readText: extractEmbeddedPayloadText,
  });
  if (preview.isErr()) {
    return Result.err(preview.error);
  }
  return Result.ok(asicDocumentText(preview.value));
};

const LEGAL_TEXT_READERS = {
  asicE: extractAsicText,
  asicS: extractAsicText,
  cades: extractCadesText,
  dataBox: extractDataBoxText,
} satisfies Record<
  LegalFileFormatKind,
  (
    options: LegalTextReadOptions,
  ) => Promise<Result<string | null, LegalTextReadError | EmailParseError>>
>;

type ExtractOptions = {
  fileBytes: Uint8Array;
  mimeType: string;
  maxChars: number;
  nestingDepth?: number;
  includeContainerAttachments?: boolean;
};

const extract = async ({
  fileBytes,
  mimeType,
  maxChars,
  nestingDepth = 0,
  includeContainerAttachments = false,
}: ExtractOptions): Promise<
  Result<string | null, EmailParseError | LegalTextReadError>
> => {
  const normalizedMimeType = normalizeMimeType(mimeType);
  let text: string | null = null;

  if (normalizedMimeType === PDF_MIME_TYPE) {
    text = await extractPdfMarkdown(fileBytes);
  } else if (normalizedMimeType === DOCX_MIME_TYPE) {
    const [documentText, reviewer] = await Promise.all([
      extractDocxText(fileBytes),
      FolioDocxReviewer.fromBuffer(toArrayBuffer(fileBytes)),
    ]);
    const content = documentText.paragraphs
      .map((paragraph) => paragraph.text)
      .join("\n");
    const notes = reviewer.getNotesAsText();
    text = joinDocxContentWithReservedNotes({ content, maxChars, notes });
  } else if (isOfficeDocumentMimeType(normalizedMimeType)) {
    text = await extractOfficeDocumentMarkdown(fileBytes);
  } else if (isDirectTextMimeType(normalizedMimeType)) {
    text = extractDirectText(fileBytes, normalizedMimeType);
  } else if (normalizedMimeType in EMAIL_MIME_TYPES) {
    return await extractEmailPlaintext({
      fileBytes,
      maxChars,
      mimeType: normalizedMimeType,
      nestingDepth,
    });
  } else {
    const legal = LEGAL_FILE_FORMATS.find(
      (format) => format.mimeType === normalizedMimeType,
    );
    if (legal) {
      const legalText = await LEGAL_TEXT_READERS[legal.kind]({
        fileBytes,
        mimeType: legal.mimeType,
        maxChars,
        nestingDepth,
        includeContainerAttachments,
      });
      if (legalText.isErr()) {
        return Result.err(legalText.error);
      }
      text = legalText.value;
    }
  }

  if (!text || text.trim().length === 0) {
    return Result.ok(null);
  }

  return Result.ok(text.slice(0, maxChars));
};

const resolveAttachmentMimeType = (
  attachment: Pick<EmailAttachment, "fileName" | "mimeType">,
): string | null => {
  const legal = legalFileFormat(attachment.mimeType, attachment.fileName);
  if (legal) {
    return legal.mimeType;
  }
  const normalized = normalizeMimeType(attachment.mimeType ?? "");
  if (canExtractMimeType(normalized)) {
    return normalized;
  }

  const extension = attachment.fileName?.split(".").pop()?.toLowerCase();
  if (!extension) {
    return null;
  }
  return ATTACHMENT_EXTENSION_MIME_TYPES[extension] ?? null;
};

const isSkippedInlineImage = (attachment: EmailAttachment): boolean =>
  attachment.contentId !== null &&
  normalizeMimeType(attachment.mimeType ?? "").startsWith("image/");

const normalizeExtractedText = (value: string): string =>
  value
    .replace(/\u00a0/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const joinExtractedParts = (
  parts: string[],
  maxChars: number,
): string | null => {
  const text = normalizeExtractedText(parts.join("\n\n"));
  if (!text) {
    return null;
  }
  return text.slice(0, maxChars);
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

/** The caller's character budget (argv[3]); the shared one when absent. */
const readMaxCharsArgument = (value: string | undefined): number => {
  if (value === undefined) {
    return LIMITS.extractedContentMaxChars;
  }
  const parsed = parseIntegerToken(value, { sign: "unsigned" }).unwrapOr(0);
  if (parsed < 1) {
    return panic("Extraction worker character budget is invalid");
  }
  return parsed;
};

const extractEmbeddedPayloadText = async (
  file: ScannedFile,
  maxChars: number,
) => {
  // Embedded data is dispatched only to leaf readers, even if an archive
  // member is itself a signed container or a message.
  const bytes = new Uint8Array(file.bytes);
  const mimeType = normalizeMimeType(file.mimeType);
  const content = await Result.tryPromise(async () => {
    if (mimeType === PDF_MIME_TYPE) {
      return await extractPdfMarkdown(bytes);
    }
    if (mimeType === DOCX_MIME_TYPE || isOfficeDocumentMimeType(mimeType)) {
      return await extractOfficeDocumentMarkdown(bytes);
    }
    if (isDirectTextMimeType(mimeType)) {
      return extractDirectText(bytes, mimeType);
    }
    return null;
  });
  if (content.isOk()) {
    return Result.ok(content.value?.slice(0, maxChars) || null);
  }

  const error = content.error.cause;
  if (error instanceof Error && "code" in error) {
    switch (error.code) {
      case "encrypted":
      case "malformed":
      case "missingPart":
      case "needsOcr":
      case "resourceLimit":
      case "unsupported":
        // Keep the container metadata readable when an embedded document has
        // no text. Only converter-declared outcomes can take this path.
        return Result.ok(null);
      default:
        break;
    }
  }
  return Result.err(content.error);
};

type CadesWorkerOptions = {
  mode: CadesWorkerMode;
  fileBytes: Uint8Array;
  fileName: string;
  maxChars: number;
};

const writeCadesPreview = async ({
  mode,
  fileBytes,
  fileName,
  maxChars,
}: CadesWorkerOptions) => {
  const payload = await scanCadesPayload(fileBytes, fileName);
  if (payload.isErr()) {
    switch (payload.error._tag) {
      case "P7mParseError":
        return Result.ok(CADES_WORKER_EXIT.unreadable);
      case "FileScanRejectedError":
        return Result.ok(CADES_WORKER_EXIT.rejected);
      case "FileScanFailedError":
        return Result.err(payload.error);
    }
  }
  const { file, layers } = payload.value;
  const bytes = new Uint8Array(file.bytes);
  if (mode === CADES_WORKER_MODE.pdf) {
    if (file.mimeType !== PDF_MIME_TYPE) {
      return Result.ok(CADES_WORKER_EXIT.unreadable);
    }
    await writeWorkerStdout(bytes);
    return Result.ok(0);
  }

  const content = await extractEmbeddedPayloadText(file, maxChars);
  if (content.isErr()) {
    return content;
  }
  const preview = {
    fileName: sanitizeFilename(file.fileName),
    mimeType: file.mimeType,
    layers,
    text: content.value ?? "",
  } satisfies v.InferOutput<typeof cadesPreviewSchema>;
  await writeWorkerStdout(JSON.stringify(preview));
  return Result.ok(0);
};

const writeAsicPreview = async (options: {
  fileBytes: Uint8Array;
  expectedMimeType: string;
  maxChars: number;
}) => {
  const preview = await extractAsicPreview({
    ...options,
    readText: extractEmbeddedPayloadText,
  });
  if (preview.isErr()) {
    switch (preview.error._tag) {
      case "AsicParseError":
        return Result.ok(ASIC_PREVIEW_WORKER_EXIT.unreadable);
      case "FileScanRejectedError":
        return Result.ok(ASIC_PREVIEW_WORKER_EXIT.rejected);
      case "FileScanFailedError":
      case "UnhandledException":
        return Result.err(preview.error);
    }
  }
  await writeWorkerStdout(JSON.stringify(preview.value));
  return Result.ok(0);
};

function exitWithWorkerError(error: unknown): never {
  const errorClass = getWorkerErrorClass(error);
  const output = sanitizeErrorForOutput(formatWorkerErrorLine(errorClass));
  process.stderr.write(
    `${typeof output === "string" ? output : formatWorkerErrorLine("UnknownError")}\n`,
  );
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────

try {
  const mimeType = process.argv[2] ?? "";
  const maxChars = readMaxCharsArgument(process.argv[3]);
  const fileBytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  if (mimeType === DATA_BOX_PREVIEW_MODE) {
    await writeWorkerStdout(JSON.stringify(extractDataBoxPreview(fileBytes)));
    process.exit(0);
  }
  if (
    mimeType === CADES_WORKER_MODE.preview ||
    mimeType === CADES_WORKER_MODE.pdf
  ) {
    const preview = await writeCadesPreview({
      mode: mimeType,
      fileBytes,
      fileName: process.argv[4] ?? "",
      maxChars,
    });
    if (preview.isErr()) {
      exitWithWorkerError(preview.error);
    }
    process.exit(preview.value);
  }
  if (mimeType === ASIC_PREVIEW_WORKER_MODE) {
    const preview = await writeAsicPreview({
      fileBytes,
      expectedMimeType: process.argv[4] ?? "",
      maxChars,
    });
    if (preview.isErr()) {
      exitWithWorkerError(preview.error);
    }
    process.exit(preview.value);
  }
  const result = await extract({
    fileBytes,
    mimeType,
    maxChars,
    includeContainerAttachments: process.argv[4] === STANDALONE_ATTACHMENT_MODE,
  });
  if (result.isErr()) {
    exitWithWorkerError(result.error);
  }
  if (result.value) {
    await writeWorkerStdout(result.value);
  }
  process.exit(0);
} catch (error) {
  exitWithWorkerError(error);
}
