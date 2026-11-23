/**
 * Sandboxed PDF worker.
 *
 * Runs as a standalone Bun subprocess. Inspects a PDF's encryption, extracts
 * every text line of a PDF, or renders a file stella lays out itself (an
 * image, plain text, CSV) as a PDF.
 *
 * Usage:  bun run pdf-worker.ts encryption|text-lines|render [type budget]
 *   (`render` takes the file's type and a `PdfRenderBudget` as JSON)
 *   stdin  → raw PDF bytes; for `render`, the file of the given type
 *   stdout → "true"/"false" for encryption, a JSON string array for text,
 *            the PDF bytes for render
 *   stderr → error messages (captured by parent)
 *   exit 0 = success, exit 65 (EX_DATAERR) = the parser or decoder refused
 *   the bytes, exit 66 = the rendered PDF is over the derivative size
 *   limit. Any other exit (Bun failing to start or to load a module exits
 *   1) is a worker failure, not a verdict on the file.
 */

import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import { Console } from "node:console";
import * as v from "valibot";

import { sanitizeErrorForOutput } from "@stll/errors";

import { renderPdf } from "@/api/lib/files/pdf-render";
import { pdfRenderBudgetSchema } from "@/api/lib/files/pdf-render-budget";
import { LIMITS } from "@/api/lib/limits";
import { writeWorkerStdout } from "@/api/lib/subprocess";

import {
  PDF_WORKER_OPERATION,
  PDF_WORKER_PARSE_ERROR_EXIT_CODE,
  PDF_WORKER_TOO_LARGE_EXIT_CODE,
  pdfWorkerOperationSchema,
} from "./pdf-worker-protocol";

// stdout carries the answer; a decoder library that logs must not corrupt
// it, so the console's stdout methods write to stderr.
const stderrConsole = new Console({
  stderr: process.stderr,
  stdout: process.stderr,
});
Object.assign(globalThis.console, {
  debug: (...values: unknown[]) => {
    stderrConsole.debug(...values);
  },
  info: (...values: unknown[]) => {
    stderrConsole.info(...values);
  },
  log: (...values: unknown[]) => {
    stderrConsole.log(...values);
  },
});

const operation = v.safeParse(pdfWorkerOperationSchema, process.argv.at(2));
if (!operation.success) {
  process.stderr.write(
    "pdf-worker: expected encryption, text-lines or render\n",
  );
  process.exit(64);
}
const operationName = operation.output;

// A declaration, so control flow knows it never returns.
function refuse(error: unknown): never {
  const outputError = sanitizeErrorForOutput(error);
  const type = outputError instanceof Error ? outputError.name : "UnknownError";
  process.stderr.write(`pdf-worker error: ${type}\n`);
  process.exit(PDF_WORKER_PARSE_ERROR_EXIT_CODE);
}

if (operationName === PDF_WORKER_OPERATION.render) {
  const budget = v.safeParse(
    pdfRenderBudgetSchema,
    Result.try((): unknown => JSON.parse(process.argv.at(4) ?? "")).unwrapOr(
      null,
    ),
  );
  if (!budget.success) {
    process.stderr.write("pdf-worker: render expects a type and a budget\n");
    process.exit(64);
  }
  // Only the decoders' refusal is a verdict on the file. Anything else that
  // throws while rendering is a defect here and exits as Bun does (1).
  const rendered = await renderPdf(
    process.argv.at(3) ?? "",
    new Uint8Array(await Bun.stdin.arrayBuffer()),
    budget.output,
  );
  if (Result.isError(rendered)) {
    refuse(rendered.error);
  } else if (
    rendered.value.type === "too-large" ||
    rendered.value.bytes.byteLength > LIMITS.fileDerivativePdfMaxBytes
  ) {
    process.stderr.write("pdf-worker: the rendered PDF is too large\n");
    process.exit(PDF_WORKER_TOO_LARGE_EXIT_CODE);
  } else {
    await writeWorkerStdout(rendered.value.bytes);
    process.exit(0);
  }
}

try {
  const fileBytes = new Uint8Array(await Bun.stdin.arrayBuffer());
  const pdf = await PDF.load(fileBytes);
  switch (operationName) {
    case PDF_WORKER_OPERATION.encryption:
      await writeWorkerStdout(String(pdf.isEncrypted));
      break;
    case PDF_WORKER_OPERATION.textLines:
      await writeWorkerStdout(
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
  refuse(error);
}
