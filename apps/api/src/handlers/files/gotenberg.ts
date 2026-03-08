import { Result, TaggedError } from "better-result";

import { env } from "@/api/env";

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

type ConvertToPdfResult = {
  buffer: ArrayBuffer;
  sizeBytes: number;
};

export class GotenbergError extends TaggedError("GotenbergError")<{
  message: string;
  statusCode?: number;
  cause?: unknown;
}>() {}

export const convertToPdf = (
  fileBuffer: ArrayBuffer,
  fileName: string,
): Promise<Result<ConvertToPdfResult, GotenbergError>> =>
  Result.tryPromise(
    {
      try: async () => {
        const formData = new FormData();
        formData.append("files", new Blob([fileBuffer]), fileName);
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

        const buffer = await response.arrayBuffer();
        return {
          buffer,
          sizeBytes: buffer.byteLength,
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
