import { Result, TaggedError, panic } from "better-result";

import {
  PDF_RASTER_MAX_OUTPUT_BYTES,
  type PdfRasterRewriteCertificate,
} from "@stll/anonymize-pdf";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { observePdfPagesLocally } from "@/api/lib/ocr-local/recognize-local";
import {
  PDF_ANONYMIZATION_ERROR_CODE,
  PDF_ANONYMIZATION_WORKER_TIMEOUT_MS,
  type PdfAnonymizationErrorCode,
} from "@/api/lib/pdf-anonymization/contract";
import { detectPdfAnonymizationPages } from "@/api/lib/pdf-anonymization/detect";
import {
  decodePdfAnonymizationWorkerResponse,
  encodePdfAnonymizationWorkerRequest,
} from "@/api/lib/pdf-anonymization/worker-protocol";
import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
} from "@/api/lib/runtime-worker-path";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

const WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: RUNTIME_WORKER_FILES.pdfAnonymization,
  sourceDir: import.meta.dir,
  sourceFile: "pdf-anonymization-worker.ts",
});
const WORKER_PROTOCOL_ALLOWANCE_BYTES = 64 * 1024;

export type PdfAnonymizationProcessResult = {
  certificate: PdfRasterRewriteCertificate;
  detectionCount: number;
  document: Uint8Array;
  pageCount: number;
};

export class PdfAnonymizationProcessError extends TaggedError(
  "PdfAnonymizationProcessError",
)<{
  message: string;
  code: PdfAnonymizationErrorCode;
  cause?: unknown;
}> {
  constructor(code: PdfAnonymizationErrorCode, cause?: unknown) {
    super({ message: "PDF anonymization failed", code, cause });
  }
}

export const processPdfAnonymization = async ({
  entityId,
  organizationId,
  scopedDb,
  signal,
  source,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  signal: AbortSignal;
  source: Uint8Array;
  workspaceId: SafeId<"workspace">;
}): Promise<
  Result<PdfAnonymizationProcessResult, PdfAnonymizationProcessError>
> =>
  await Result.tryPromise({
    try: async () => {
      const ocr = await observePdfPagesLocally({
        sourceKey: "pdf-anonymization-source",
        signal,
        readSource: () => Promise.resolve(Uint8Array.from(source).buffer),
        readSourceSize: () => Promise.resolve(source.byteLength),
      });
      if (Result.isError(ocr)) {
        throw new PdfAnonymizationProcessError(
          ocr.error.code === "not_configured"
            ? PDF_ANONYMIZATION_ERROR_CODE.ocrNotConfigured
            : PDF_ANONYMIZATION_ERROR_CODE.ocrFailed,
          ocr.error,
        );
      }
      const detections = await detectPdfAnonymizationPages({
        entityId,
        organizationId,
        pages: ocr.value.payload.pages,
        scopedDb,
        workspaceId,
      });
      const pages = ocr.value.payload.pages.map((page, pageIndex) => ({
        ocr: page,
        detections:
          detections.at(pageIndex) ?? panic("PDF detection page missing"),
      }));
      const framed = encodePdfAnonymizationWorkerRequest({
        document: source,
        pages,
      });
      const output = await spawnBinaryWorker({
        workerPath: WORKER_PATH,
        stdin: new Blob([Uint8Array.from(framed).buffer]),
        timeoutMs: PDF_ANONYMIZATION_WORKER_TIMEOUT_MS,
        maxOutputBytes:
          PDF_RASTER_MAX_OUTPUT_BYTES + WORKER_PROTOCOL_ALLOWANCE_BYTES,
        signal,
      });
      if (Result.isError(output)) {
        throw new PdfAnonymizationProcessError(
          PDF_ANONYMIZATION_ERROR_CODE.rewriteFailed,
          output.error,
        );
      }
      const rewritten = decodePdfAnonymizationWorkerResponse(output.value);
      const detectionCount = pages.reduce(
        (count, page) => count + page.detections.length,
        0,
      );
      if (
        rewritten.certificate.sourceSha256 !==
          new Bun.CryptoHasher("sha256").update(source).digest("hex") ||
        rewritten.certificate.outputSha256 !==
          new Bun.CryptoHasher("sha256")
            .update(rewritten.document)
            .digest("hex") ||
        rewritten.certificate.detectionCount !== detectionCount ||
        rewritten.certificate.pageCount !== pages.length
      ) {
        throw new PdfAnonymizationProcessError(
          PDF_ANONYMIZATION_ERROR_CODE.rewriteFailed,
        );
      }
      return {
        certificate: rewritten.certificate,
        detectionCount,
        document: rewritten.document,
        pageCount: pages.length,
      };
    },
    catch: (cause) =>
      cause instanceof PdfAnonymizationProcessError
        ? cause
        : new PdfAnonymizationProcessError(
            PDF_ANONYMIZATION_ERROR_CODE.invalidPdf,
            cause,
          ),
  });
