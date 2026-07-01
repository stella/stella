/**
 * Sandboxed extraction worker.
 *
 * Runs as a standalone Bun subprocess. Receives the MIME type
 * as a CLI argument and raw file bytes on stdin; writes
 * extracted plain text to stdout.
 *
 * If the parser crashes or hangs, the parent process kills this
 * subprocess via timeout; the main API server is unaffected.
 *
 * Usage:  bun run extraction-worker.ts <mimeType>
 *   stdin  → raw file bytes
 *   stdout → extracted text (empty if none)
 *   stderr → error messages (captured by parent)
 *   exit 0 = success, exit 1 = extraction error
 */

import {
  EMAIL_MIME_TYPES,
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
  parseEmail,
  parsedEmailToText,
  type EmailAttachment,
} from "@/api/handlers/files/email-to-html";
import { LIMITS } from "@/api/lib/limits";
import {
  extractWithXberg,
  isXbergSupported,
} from "@/api/lib/search/xberg-extractor";
import { extractFolioBlockTextFromDocxBuffer } from "@/api/lib/workflow/docx-blocks";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const EMAIL_ATTACHMENT_MAX_COUNT = 25;
const EMAIL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const EMAIL_MAX_NESTING_DEPTH = 2;

const ATTACHMENT_EXTENSION_MIME_TYPES: Record<string, string> = {
  csv: "text/csv",
  docx: DOCX_MIME_TYPE,
  eml: EML_MIME_TYPE,
  htm: "text/html",
  html: "text/html",
  ics: "text/calendar",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  msg: MSG_MIME_TYPE,
  text: "text/plain",
  txt: "text/plain",
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

    // oxlint-disable-next-line no-await-in-loop -- sequential recursive extraction preserves attachment order and bounds memory
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

  if (isXbergSupported(normalizedMimeType)) {
    const xbergResult = await extractWithXberg(fileBytes, normalizedMimeType);

    text = xbergResult.text;
  } else if (normalizedMimeType === DOCX_MIME_TYPE) {
    text = await extractFolioBlockTextFromDocxBuffer(fileBytes);
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

const canExtractMimeType = (mimeType: string): boolean => {
  const normalized = normalizeMimeType(mimeType);
  return (
    normalized === DOCX_MIME_TYPE ||
    isXbergSupported(normalized) ||
    normalized in EMAIL_MIME_TYPES
  );
};

const isSkippedInlineImage = (attachment: EmailAttachment): boolean =>
  attachment.contentId !== null &&
  normalizeMimeType(attachment.mimeType ?? "").startsWith("image/");

const normalizeMimeType = (mimeType: string): string =>
  mimeType.split(";").at(0)?.trim().toLowerCase() ?? "";

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

const normalizeExtractedText = (value: string): string =>
  value
    .replace(/\u00a0/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

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
