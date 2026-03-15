/**
 * Upload a file for chat context. The file is processed in
 * memory (never stored persistently) and returned as either
 * a base64 data URL (images, PDFs) or extracted text views
 * (DOCX, plain text).
 */

import { Result } from "better-result";
import { status, t } from "elysia";

import { extractTextForChat } from "@/api/handlers/docx/extract-text-chat";
import { scanFile } from "@/api/lib/file-scan/scan";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

// ── MIME allowlist ───────────────────────────────────────

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const NATIVE_FILE_MIMES = new Set([...IMAGE_MIMES, "application/pdf"]);

const TEXT_MIMES = new Set(["text/plain", "text/csv", "text/markdown"]);

const ALLOWED_MIMES = new Set([
  ...NATIVE_FILE_MIMES,
  DOCX_MIME_TYPE,
  ...TEXT_MIMES,
]);

// ── Response types ───────────────────────────────────────

type NativeFileResponse = {
  type: "native-file";
  dataUrl: string;
  mediaType: string;
  filename: string;
};

type ExtractedTextResponse = {
  type: "extracted-text";
  filename: string;
  mediaType: string;
  views: {
    simple: string;
    original?: string | undefined;
    trackedChanges?: string | undefined;
  };
};

// ── Body schema ──────────────────────────────────────────

export const uploadContextFileBodySchema = t.Object({
  file: t.File({
    maxSize: FILE_SIZE_LIMITS.chatContextFile,
  }),
});

// ── Handler ──────────────────────────────────────────────

export const uploadContextFileHandler = async ({ file }: { file: File }) => {
  const mimeType = file.type;

  if (!ALLOWED_MIMES.has(mimeType)) {
    return status(400, {
      message: "Unsupported file type",
    });
  }

  const fileBuffer = new Uint8Array(await file.arrayBuffer());

  // Security scan
  const scanResult = await scanFile({
    buffer: fileBuffer,
    declaredMimeType: mimeType,
    fileName: file.name,
  });

  if (Result.isError(scanResult)) {
    return status(422, {
      message: "File security scan failed",
    });
  }

  if (scanResult.value.verdict === "reject") {
    return status(422, {
      message: "File rejected by security scan",
    });
  }

  // Native files: convert to base64 data URL
  if (NATIVE_FILE_MIMES.has(mimeType)) {
    const base64 = Buffer.from(fileBuffer).toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return {
      type: "native-file",
      dataUrl,
      mediaType: mimeType,
      filename: file.name,
    } satisfies NativeFileResponse;
  }

  // DOCX: extract with tracked changes
  if (mimeType === DOCX_MIME_TYPE) {
    const docResult = await Result.tryPromise(
      async () => await extractTextForChat(fileBuffer),
    );
    if (Result.isError(docResult)) {
      return status(422, {
        message: "Failed to extract document content",
      });
    }
    const doc = docResult.value;
    const maxChars = LIMITS.chatContextFileMaxChars;

    return {
      type: "extracted-text",
      filename: file.name,
      mediaType: mimeType,
      views: {
        simple: doc.simple.slice(0, maxChars),
        original: doc.original.slice(0, maxChars) || undefined,
        trackedChanges: doc.trackedChanges.slice(0, maxChars) || undefined,
      },
    } satisfies ExtractedTextResponse;
  }

  // Plain text: read directly
  if (TEXT_MIMES.has(mimeType)) {
    const text = new TextDecoder().decode(fileBuffer);
    const maxChars = LIMITS.chatContextFileMaxChars;

    return {
      type: "extracted-text",
      filename: file.name,
      mediaType: mimeType,
      views: {
        simple: text.slice(0, maxChars),
      },
    } satisfies ExtractedTextResponse;
  }

  return status(400, {
    message: "Unsupported file type",
  });
};
