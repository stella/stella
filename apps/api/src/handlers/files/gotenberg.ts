import { Result, TaggedError } from "better-result";

import { env } from "@/api/env";
import { applyFitToPage } from "@/api/handlers/files/xlsx-preprocess";

/**
 * MIME types that Gotenberg's LibreOffice route can convert
 * to PDF. Derived from the official documentation:
 * https://gotenberg.dev/docs/convert-with-libreoffice/convert-to-pdf
 */
const CONVERTIBLE_MIME_TYPES = {
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
} as const satisfies Record<string, null>;

export const isConvertibleMimeType = (mimeType: string): boolean =>
  mimeType in CONVERTIBLE_MIME_TYPES;

/**
 * MIME types that the frontend can render natively without
 * Gotenberg conversion. Currently only DOCX (via Folio).
 * Images intentionally remain converted to PDF.
 */
const NATIVELY_RENDERABLE_MIME_TYPES = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    null,
} as const satisfies Record<string, null>;

export const isNativelyRenderableMimeType = (mimeType: string): boolean =>
  mimeType in NATIVELY_RENDERABLE_MIME_TYPES;

type ShouldGeneratePdfDerivativeOptions = {
  encrypted?: boolean;
  mimeType: string;
};

export const shouldGeneratePdfDerivative = ({
  encrypted = false,
  mimeType,
}: ShouldGeneratePdfDerivativeOptions): boolean =>
  !encrypted &&
  isConvertibleMimeType(mimeType) &&
  !isNativelyRenderableMimeType(mimeType);

export const pdfDerivativeStateForFile = (
  options: ShouldGeneratePdfDerivativeOptions,
) =>
  shouldGeneratePdfDerivative(options)
    ? ({ status: "pending" } as const)
    : ({ status: "not-required" } as const);

/**
 * Spreadsheet MIME types (.xls, .xlsx) that benefit from the
 * fit-to-page pre-processor. ODS uses ODF format (different ZIP
 * structure), so we skip it.
 */
const XLSX_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/**
 * Image MIME types that benefit from the Chromium HTML route
 * instead of LibreOffice (which adds A4 whitespace around the
 * image).
 */
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "image/webp",
]);

type ConvertToPdfResult = {
  buffer: ArrayBuffer;
  sizeBytes: number;
};

class GotenbergError extends TaggedError("GotenbergError")<{
  message: string;
  statusCode?: number;
  cause?: unknown;
}>() {}

const gotenbergAuth = (): string => {
  const credentials = Buffer.from(
    `${env.GOTENBERG_USERNAME}:${env.GOTENBERG_PASSWORD}`,
  ).toString("base64");
  return `Basic ${credentials}`;
};

const GOTENBERG_RETRY = {
  times: 2,
  delayMs: 2000,
  backoff: "exponential",
  shouldRetry: (error: GotenbergError) =>
    error.statusCode === undefined || error.statusCode >= 500,
} as const;

/** Post an HTML document to Gotenberg's Chromium route. */
const chromiumHtmlToPdf = async (
  html: string,
  formFields: Record<string, string>,
): Promise<ConvertToPdfResult> => {
  const formData = new FormData();
  formData.append(
    "files",
    new Blob([html], { type: "text/html" }),
    "index.html",
  );
  for (const [key, value] of Object.entries(formFields)) {
    formData.append(key, value);
  }

  const response = await fetch(
    `${env.GOTENBERG_URL}/forms/chromium/convert/html`,
    {
      method: "POST",
      headers: { Authorization: gotenbergAuth() },
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
  return { buffer: result, sizeBytes: result.byteLength };
};

// ── Image dimension parsing ──────────────────────────────

type ImageSize = { width: number; height: number };

/** Read width/height from a PNG IHDR chunk (bytes 16..23). */
const parsePngSize = (buf: Uint8Array): ImageSize | null => {
  // PNG signature: 137 80 78 71 13 10 26 10
  // Need at least 24 bytes: 8-byte signature + 4-byte length
  // + 4-byte IHDR tag + 4-byte width + 4-byte height
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) {
    return null;
  }
  const view = new DataView(buf.buffer, buf.byteOffset);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
};

/** Read width/height from the first JPEG SOF marker. */
const parseJpegSize = (buf: Uint8Array): ImageSize | null => {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset < buf.length - 1) {
    if (buf[offset] !== 0xff) {
      return null;
    }
    const marker = buf.at(offset + 1);
    if (marker === undefined) {
      return null;
    }
    // SOF0..SOF3 markers carry dimensions
    if (marker >= 0xc0 && marker <= 0xc3) {
      if (offset + 8 >= buf.length) {
        return null;
      }
      const view = new DataView(buf.buffer, buf.byteOffset);
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    }
    // Skip to next marker
    if (offset + 3 >= buf.length) {
      return null;
    }
    const len = new DataView(buf.buffer, buf.byteOffset).getUint16(offset + 2);
    offset += 2 + len;
  }
  return null;
};

/** Best-effort image dimension extraction from raw bytes. */
const getImageSize = (buf: ArrayBuffer, mimeType: string): ImageSize | null => {
  const bytes = new Uint8Array(buf);
  if (mimeType === "image/png") {
    return parsePngSize(bytes);
  }
  if (mimeType === "image/jpeg") {
    return parseJpegSize(bytes);
  }
  return null;
};

// ── Image-to-PDF conversion ─────────────────────────────

/** Pixels to inches at 96 DPI (Chromium's default). */
const pxToIn = (px: number) => px / 96;

/**
 * Convert an image to PDF via Gotenberg's Chromium HTML route.
 * Reads the image dimensions, sets @page size to match, and
 * produces a PDF with no margins or whitespace.
 *
 * Falls back to the LibreOffice route for formats whose
 * dimensions we can't parse (GIF, TIFF, BMP, WebP).
 */
const convertImageToPdf = async (
  fileBuffer: ArrayBuffer,
  mimeType: string,
  size: ImageSize,
): Promise<ConvertToPdfResult> => {
  const base64 = Buffer.from(fileBuffer).toString("base64");
  const dataUri = `data:${mimeType};base64,${base64}`;

  const html = `<!DOCTYPE html>
<html>
<head><style>
@page {
  size: ${size.width}px ${size.height}px;
  margin: 0;
}
* { margin: 0; padding: 0; }
img { display: block; width: ${size.width}px; height: ${size.height}px; }
</style></head>
<body><img src="${dataUri}"></body>
</html>`;

  return await chromiumHtmlToPdf(html, {
    paperWidth: String(pxToIn(size.width)),
    paperHeight: String(pxToIn(size.height)),
    marginTop: "0",
    marginBottom: "0",
    marginLeft: "0",
    marginRight: "0",
    preferCssPageSize: "true",
  });
};

export const convertToPdf = async (
  fileBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<Result<ConvertToPdfResult, GotenbergError>> => {
  const imageSize = IMAGE_MIME_TYPES.has(mimeType)
    ? getImageSize(fileBuffer, mimeType)
    : null;

  if (imageSize) {
    return Result.tryPromise(
      {
        try: async () =>
          await convertImageToPdf(fileBuffer, mimeType, imageSize),
        catch: (cause) =>
          cause instanceof GotenbergError
            ? cause
            : new GotenbergError({
                message: "Failed to convert image",
                cause,
              }),
      },
      { retry: GOTENBERG_RETRY },
    );
  }

  return await Result.tryPromise(
    {
      try: async () => {
        const buffer = XLSX_MIME_TYPES.has(mimeType)
          ? await applyFitToPage(fileBuffer)
          : fileBuffer;

        const formData = new FormData();
        formData.append("files", new Blob([buffer]), fileName);
        formData.append("exportNotes", "true");
        formData.append("exportNotesInMargin", "true");

        const response = await fetch(
          `${env.GOTENBERG_URL}/forms/libreoffice/convert`,
          {
            method: "POST",
            headers: {
              Authorization: gotenbergAuth(),
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
    { retry: GOTENBERG_RETRY },
  );
};
