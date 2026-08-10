import { Result, TaggedError } from "better-result";
import path from "node:path";

import type { DocumentOcrPayload } from "@/api/lib/document-processing-contract";
import { serializeDocumentOcrPayload } from "@/api/lib/document-processing-contract";
import { LIMITS } from "@/api/lib/limits";
import {
  resolveOcrPdfFontPath,
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
} from "@/api/lib/runtime-worker-path";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

const WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: RUNTIME_WORKER_FILES.ocrSearchablePdf,
  sourceDir: import.meta.dir,
  sourceFile: "ocr-searchable-pdf-worker.ts",
});
const LOCAL_FONT_PATH = path.resolve(
  import.meta.dir,
  "../../../landing/public/fonts/CabinetGrotesk-Regular.otf",
);
const INPUT_HEADER_BYTES = 4;
const MAX_DERIVATIVE_OVERHEAD_BYTES = 32 * 1024 * 1024;

class OcrSearchablePdfError extends TaggedError("OcrSearchablePdfError")<{
  message: string;
  cause?: unknown;
}> {}

const encodeWorkerInput = (
  source: ArrayBuffer,
  payload: DocumentOcrPayload,
): Blob => {
  const payloadBytes = new TextEncoder().encode(
    serializeDocumentOcrPayload(payload),
  );
  const header = new Uint8Array(INPUT_HEADER_BYTES);
  new DataView(header.buffer).setUint32(0, payloadBytes.byteLength);
  return new Blob([header, payloadBytes, source]);
};

export const createOcrSearchablePdf = async (
  source: ArrayBuffer,
  payload: DocumentOcrPayload,
): Promise<Result<Uint8Array, OcrSearchablePdfError>> => {
  const result = await spawnBinaryWorker({
    workerPath: WORKER_PATH,
    args: [resolveOcrPdfFontPath(LOCAL_FONT_PATH)],
    stdin: encodeWorkerInput(source, payload),
    timeoutMs: LIMITS.ocrPdfGenerationTimeoutMs,
    maxOutputBytes: source.byteLength + MAX_DERIVATIVE_OVERHEAD_BYTES,
  });
  if (Result.isError(result)) {
    return Result.err(
      new OcrSearchablePdfError({
        message: "Failed to create searchable PDF",
        cause: result.error,
      }),
    );
  }
  return Result.ok(result.value);
};
