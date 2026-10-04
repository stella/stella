/**
 * Sandboxed PDF worker.
 *
 * Runs as a standalone Bun subprocess. Receives raw PDF bytes
 * on stdin and checks whether the PDF is encrypted.
 *
 * Usage:  bun run pdf-worker.ts
 *   stdin  → raw PDF bytes
 *   stdout → "true" or "false"
 *   stderr → error messages (captured by parent)
 *   exit 0 = success, exit 65 (EX_DATAERR) = the parser refused the bytes.
 *   Any other exit (Bun failing to start or to load a module exits 1) is a
 *   worker failure, not a verdict on the file.
 */

import { PDF } from "@libpdf/core";

try {
  const fileBytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  const pdf = await PDF.load(fileBytes);
  process.stdout.write(String(pdf.isEncrypted));
  process.exit(0);
} catch (error) {
  const type = error instanceof Error ? error.constructor.name : "UnknownError";
  process.stderr.write(`pdf-worker error: ${type}\n`);
  // Keep in sync with PDF_WORKER_PARSE_ERROR_EXIT_CODE in pdf-utils.ts.
  process.exit(65);
}
