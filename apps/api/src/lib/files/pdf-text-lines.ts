import { Result } from "better-result";
import * as v from "valibot";

import { SubprocessError } from "@/api/lib/errors/tagged-errors";
import {
  PDF_WORKER_OPERATION,
  pdfTextLinesSchema,
  pdfWorkerPath,
} from "@/api/lib/files/pdf-worker-protocol";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

const PDF_TEXT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Every PDF text line, parsed outside the caller's event loop. */
export const readPdfTextLines = async (
  bytes: Uint8Array,
  timeoutMs: number,
) => {
  const result = await spawnBinaryWorker({
    workerPath: pdfWorkerPath(),
    args: [PDF_WORKER_OPERATION.textLines],
    stdin: new Blob([new Uint8Array(bytes)]),
    timeoutMs,
    maxOutputBytes: PDF_TEXT_MAX_OUTPUT_BYTES,
  });
  if (Result.isError(result)) {
    return result;
  }
  return Result.try({
    try: () =>
      v.parse(
        pdfTextLinesSchema,
        JSON.parse(new TextDecoder().decode(result.value)),
      ),
    catch: (cause) =>
      new SubprocessError({
        message: "PDF text worker returned an invalid response",
        exitCode: 0,
        termination: null,
        cause,
      }),
  });
};
