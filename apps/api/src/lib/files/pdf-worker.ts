/**
 * Sandboxed PDF worker.
 *
 * Runs as a standalone Bun subprocess. Receives raw PDF bytes
 * on stdin and inspects encryption or extracts every text line.
 *
 * Usage:  bun run pdf-worker.ts encryption|text-lines
 *   stdin  → raw PDF bytes
 *   stdout → "true"/"false" for encryption, a JSON string array for text
 *   stderr → error messages (captured by parent)
 *   exit 0 = success, exit 65 (EX_DATAERR) = the parser refused the bytes.
 *   Any other exit (Bun failing to start or to load a module exits 1) is a
 *   worker failure, not a verdict on the file.
 */

import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import * as v from "valibot";

import { sanitizeErrorForOutput } from "@stll/errors";

import {
  PDF_WORKER_OPERATION,
  PDF_WORKER_PARSE_ERROR_EXIT_CODE,
  pdfWorkerOperationSchema,
} from "./pdf-worker-protocol";

const operation = v.safeParse(pdfWorkerOperationSchema, process.argv.at(2));
if (!operation.success) {
  process.stderr.write("pdf-worker: expected encryption or text-lines\n");
  process.exit(64);
}
const operationName = operation.output;

try {
  const fileBytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  const pdf = await PDF.load(fileBytes);
  switch (operationName) {
    case PDF_WORKER_OPERATION.encryption:
      process.stdout.write(String(pdf.isEncrypted));
      break;
    case PDF_WORKER_OPERATION.textLines:
      process.stdout.write(
        JSON.stringify(
          pdf
            .getPages()
            .flatMap((page) =>
              page.extractText().lines.map(({ text }) => text),
            ),
        ),
      );
      break;
    default:
      operationName satisfies never;
      panic("Unhandled PDF worker operation");
  }
  process.exit(0);
} catch (error) {
  const outputError = sanitizeErrorForOutput(error);
  const type = outputError instanceof Error ? outputError.name : "UnknownError";
  process.stderr.write(`pdf-worker error: ${type}\n`);
  process.exit(PDF_WORKER_PARSE_ERROR_EXIT_CODE);
}
