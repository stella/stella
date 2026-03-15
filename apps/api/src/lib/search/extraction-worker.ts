/**
 * Sandboxed extraction worker.
 *
 * Runs as a standalone Bun subprocess. Receives the MIME type
 * as a CLI argument and raw file bytes on stdin; writes a JSON
 * result to stdout.
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

import { extractText as extractPdfText } from "unpdf";

import { extractText as extractDocxText } from "@/api/handlers/docx/extract-text";
import { LIMITS } from "@/api/lib/limits";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

const extract = async (
  fileBytes: Uint8Array,
  mimeType: string,
  maxChars: number,
): Promise<string | null> => {
  let text: string | null = null;

  if (mimeType === PDF_MIME_TYPE) {
    const result = await extractPdfText(fileBytes, {
      mergePages: true,
    });
    text = result.text;
  } else if (mimeType === DOCX_MIME_TYPE) {
    const doc = await extractDocxText(fileBytes);
    text = doc.paragraphs.map((p) => p.text).join("\n");
  }

  if (!text || text.trim().length === 0) {
    return null;
  }

  return text.slice(0, maxChars);
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
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`extraction-worker error: ${message}\n`);
  process.exit(1);
}
