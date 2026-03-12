import { Result, TaggedError } from "better-result";

import { env } from "@/api/env";
import { applyFitToPage } from "@/api/handlers/files/xlsx-preprocess";

/**
 * MIME types that Gotenberg's LibreOffice route can convert
 * to PDF. Derived from the official documentation:
 * https://gotenberg.dev/docs/convert-with-libreoffice/convert-to-pdf
 */
const CONVERTIBLE_MIME_TYPES: Record<string, null> = {
  // Word processing
  "application/msword": null,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    null,
  "application/vnd.oasis.opendocument.text": null,
  "application/rtf": null,
  "text/plain": null,
  "application/vnd.apple.pages": null,

  // Spreadsheets
  "application/vnd.ms-excel": null,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": null,
  "application/vnd.oasis.opendocument.spreadsheet": null,
  "text/csv": null,

  // Presentations
  "application/vnd.ms-powerpoint": null,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    null,
  "application/vnd.oasis.opendocument.presentation": null,

  // Images
  "image/jpeg": null,
  "image/png": null,
  "image/gif": null,
  "image/tiff": null,
  "image/bmp": null,
  "image/webp": null,

  // Web
  "text/html": null,
  "application/xhtml+xml": null,
};

export const isConvertibleMimeType = (mimeType: string): boolean =>
  mimeType in CONVERTIBLE_MIME_TYPES;

/**
 * Spreadsheet MIME types (.xls, .xlsx) that benefit from the
 * fit-to-page pre-processor. ODS uses ODF format (different ZIP
 * structure), so we skip it.
 */
const XLSX_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

type ConvertToPdfResult = {
  buffer: ArrayBuffer;
  sizeBytes: number;
};

export class GotenbergError extends TaggedError("GotenbergError")<{
  message: string;
  statusCode?: number;
  cause?: unknown;
}>() {}

export const convertToPdf = async (
  fileBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<Result<ConvertToPdfResult, GotenbergError>> =>
  await Result.tryPromise(
    {
      try: async () => {
        const buffer = XLSX_MIME_TYPES.has(mimeType)
          ? await applyFitToPage(fileBuffer)
          : fileBuffer;

        const formData = new FormData();
        formData.append("files", new Blob([buffer]), fileName);
        formData.append("exportNotes", "true");
        formData.append("exportNotesInMargin", "true");

        const credentials = Buffer.from(
          `${env.GOTENBERG_USERNAME}:${env.GOTENBERG_PASSWORD}`,
        ).toString("base64");

        const response = await fetch(
          `${env.GOTENBERG_URL}/forms/libreoffice/convert`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${credentials}`,
            },
            body: formData,
            signal: AbortSignal.timeout(30_000),
          },
        );

        if (!response.ok) {
          throw new GotenbergError({
            message: `Gotenberg returned ${response.status}`,
            statusCode: response.status,
          });
        }

        const result = await response.arrayBuffer();
        return {
          buffer: result,
          sizeBytes: result.byteLength,
        };
      },
      catch: (cause) => {
        if (cause instanceof GotenbergError) {
          return cause;
        }
        return new GotenbergError({
          message: "Failed to reach Gotenberg",
          cause,
        });
      },
    },
    {
      retry: {
        times: 2,
        delayMs: 2000,
        backoff: "exponential",
        shouldRetry: (error) =>
          error.statusCode === undefined || error.statusCode >= 500,
      },
    },
  );
