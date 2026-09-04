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
  await Result.gen(async function* () {
    const ocr = yield* Result.await(
      observePdfPagesLocally({
        sourceKey: "pdf-anonymization-source",
        signal,
        readSource: async () =>
          await Promise.resolve(Uint8Array.from(source).buffer),
        readSourceSize: async () => await Promise.resolve(source.byteLength),
      }).then((result) =>
        result.mapError(
          (error) =>
            new PdfAnonymizationProcessError(
              error.code === "not_configured"
                ? PDF_ANONYMIZATION_ERROR_CODE.ocrNotConfigured
                : PDF_ANONYMIZATION_ERROR_CODE.ocrFailed,
              error,
            ),
        ),
      ),
    );
    const detections = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await detectPdfAnonymizationPages({
            entityId,
            organizationId,
            pages: ocr.payload.pages,
            scopedDb,
            workspaceId,
          }),
        catch: (cause) =>
          new PdfAnonymizationProcessError(
            PDF_ANONYMIZATION_ERROR_CODE.internal,
            cause,
          ),
      }),
    );
    const pages = ocr.payload.pages.map((page, pageIndex) => ({
      ocr: page,
      detections:
        detections.at(pageIndex) ?? panic("PDF detection page missing"),
    }));
    const framed = yield* encodePdfAnonymizationWorkerRequest({
      document: source,
      pages,
    }).mapError(
      (cause) =>
        new PdfAnonymizationProcessError(
          PDF_ANONYMIZATION_ERROR_CODE.rewriteFailed,
          cause,
        ),
    );
    const output = yield* Result.await(
      spawnBinaryWorker({
        workerPath: WORKER_PATH,
        stdin: new Blob([Uint8Array.from(framed).buffer]),
        timeoutMs: PDF_ANONYMIZATION_WORKER_TIMEOUT_MS,
        maxOutputBytes:
          PDF_RASTER_MAX_OUTPUT_BYTES + WORKER_PROTOCOL_ALLOWANCE_BYTES,
        signal,
      }).then((result) =>
        result.mapError(
          (error) =>
            new PdfAnonymizationProcessError(
              PDF_ANONYMIZATION_ERROR_CODE.rewriteFailed,
              error,
            ),
        ),
      ),
    );
    const rewritten = yield* decodePdfAnonymizationWorkerResponse(
      output,
    ).mapError(
      (cause) =>
        new PdfAnonymizationProcessError(
          PDF_ANONYMIZATION_ERROR_CODE.rewriteFailed,
          cause,
        ),
    );
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
      return Result.err(
        new PdfAnonymizationProcessError(
          PDF_ANONYMIZATION_ERROR_CODE.rewriteFailed,
        ),
      );
    }
    return Result.ok({
      certificate: rewritten.certificate,
      detectionCount,
      document: rewritten.document,
      pageCount: pages.length,
    });
  });
