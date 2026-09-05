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
 *   stderr → error messages (captured by parent)
 *   exit 0 = success, exit 1 = extraction error
 */

import { toMarkdownBytes } from "@firecrawl/anydoc";
import { load } from "cheerio";

import { FolioDocxReviewer } from "@stll/folio-core/server";

import { extractText as extractDocxText } from "@/api/lib/docx/extract-text";
import {
  EMAIL_MIME_TYPES,
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
  parseEmail,
  parsedEmailToText,
  type EmailAttachment,
} from "@/api/lib/files/email-to-html";
import { LIMITS } from "@/api/lib/limits";
import {
  canExtractMimeType,
  isDirectTextMimeType,
  isOfficeDocumentMimeType,
  normalizeMimeType,
} from "@/api/lib/search/extractable-mime-types";
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
}): Promise<string | null> => {
  const parsed = await parseEmail(toArrayBuffer(fileBytes), mimeType);
  const parts: string[] = [];
  const body = parsedEmailToText(parsed);
  if (body) {
    parts.push(body);
  }

  if (nestingDepth >= EMAIL_MAX_NESTING_DEPTH) {
    return joinExtractedParts(parts, maxChars);
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

  return joinExtractedParts(parts, maxChars);
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
  try {
    return await extract(bytes, mimeType, maxChars, nestingDepth);
  } catch {
    return null;
  }
};

const extract = async (
  fileBytes: Uint8Array,
  mimeType: string,
  maxChars: number,
  nestingDepth = 0,
): Promise<string | null> => {
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
    text = await extractEmailPlaintext({
      fileBytes,
      maxChars,
      mimeType: normalizedMimeType,
      nestingDepth,
    });
  }

  if (!text || text.trim().length === 0) {
    return null;
  }

  return text.slice(0, maxChars);
};

const resolveAttachmentMimeType = (
  attachment: EmailAttachment,
): string | null => {
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

// ── Main ──────────────────────────────────────────────────

try {
  const mimeType = process.argv[2] ?? "";
  const fileBytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  const text = await extract(
    fileBytes,
    mimeType,
    LIMITS.extractedContentMaxChars,
  );
  if (text) {
    process.stdout.write(text);
  }
  process.exit(0);
} catch (error) {
  const type = error instanceof Error ? error.constructor.name : "UnknownError";
  process.stderr.write(`extraction-worker error: ${type}\n`);
  process.exit(1);
}
