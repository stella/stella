import { desktopEditFileTypeForMimeType } from "@stll/api-contract";
import type { ConvertedDocumentMimeType } from "@stll/api-contract/converted-document-formats";

/**
 * MIME types accepted by Gotenberg's LibreOffice conversion route, every
 * converted document format's aliases included.
 */
const CONVERTIBLE_MIME_TYPES = {
  "application/msword": null,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    null,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": null,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    null,
  "application/vnd.ms-excel": null,
  "application/vnd.ms-powerpoint": null,
  "application/vnd.ms-works": null,
  "application/vnd.oasis.opendocument.presentation": null,
  "application/vnd.oasis.opendocument.spreadsheet": null,
  "application/vnd.oasis.opendocument.text": null,
  "application/rtf": null,
  "application/vnd.apple.numbers": null,
  "application/vnd.apple.pages": null,
  "application/vnd.wordperfect": null,
  "application/wordperfect": null,
  "application/wordperfect5.1": null,
  "application/x-iwork-numbers-sffnumbers": null,
  "application/x-iwork-pages-sffpages": null,
  "application/x-wordperfect": null,
  "application/xhtml+xml": null,
  "image/bmp": null,
  "image/gif": null,
  "image/jpeg": null,
  "image/png": null,
  "image/tiff": null,
  "image/webp": null,
  "text/csv": null,
  "text/html": null,
  "text/plain": null,
} as const satisfies Record<string, null> &
  Record<ConvertedDocumentMimeType, null>;

export type ConvertibleMime = keyof typeof CONVERTIBLE_MIME_TYPES;

export const isConvertibleMimeType = (
  mimeType: string,
): mimeType is ConvertibleMime =>
  Object.hasOwn(CONVERTIBLE_MIME_TYPES, mimeType);

/** OOXML formats rendered in-browser and therefore excluded from the derivative queue. */
export const isNativelyRenderableMimeType = (mimeType: string): boolean =>
  desktopEditFileTypeForMimeType(mimeType) !== null;

type ShouldGeneratePdfDerivativeOptions = {
  encrypted: boolean;
  mimeType: string;
};

export const shouldGeneratePdfDerivative = ({
  encrypted,
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
