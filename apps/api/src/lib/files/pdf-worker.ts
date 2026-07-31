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
 *   exit 0 = success, exit 1 = parse error (corrupted PDF)
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
  process.exit(1);
}
