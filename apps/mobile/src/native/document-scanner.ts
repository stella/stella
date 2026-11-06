import { Result, TaggedError } from "better-result";
import { requireOptionalNativeModule } from "expo";

/** The scanner could not capture, read or bind pages, or this build has none. */
export class DocumentScannerError extends TaggedError("DocumentScannerError")<{
  message: string;
  cause?: unknown;
}> {}

/** One page the document camera captured: an image in the app's temporary files. */
export type ScannedPage = {
  readonly uri: string;
  /** A small copy for the list of pages. */
  readonly thumbnailUri: string;
  /** Bytes of the full page, which the PDF takes as it is. */
  readonly size: number;
};

/** A page to bind into a PDF, turned clockwise by `rotation` degrees. */
export type PdfPage = {
  readonly uri: string;
  readonly rotation: number;
};

/** The PDF the pages were bound into. */
export type BuiltPdf = {
  readonly uri: string;
  readonly pageCount: number;
  /** Bytes, and the SHA-256 in lowercase hex: what an upload is signed for. */
  readonly size: number;
  readonly sha256Hex: string;
};

type DocumentScannerModule = {
  readonly isSupported: () => boolean;
  /** Null when the person closed the camera without saving. */
  readonly scan: (review: string) => Promise<readonly ScannedPage[] | null>;
  readonly buildPdf: (
    review: string,
    name: string,
    pages: readonly PdfPage[],
  ) => Promise<BuiltPdf>;
  readonly discard: (review: string) => void;
};

// Absent on Android, the web and a client built before the scanner.
const scanner =
  requireOptionalNativeModule<DocumentScannerModule>("DocumentScanner");

/** Whether this device can scan: it has the document camera, and the build has the scanner. */
export const canScan = (): boolean => scanner?.isSupported() ?? false;

/**
 * Opens the system document camera. It finds each page's edges and
 * straightens it as it captures; the pages come back as separate images, in
 * the order they were taken, into the files of `review`: a UUID that names
 * the review they are for, so each review keeps its files apart from
 * another's. Null when the person closed the camera without saving.
 */
export const scanPages = async (
  review: string,
): Promise<Result<readonly ScannedPage[] | null, DocumentScannerError>> => {
  const native = scanner;
  return native === null
    ? Result.ok(null)
    : await Result.tryPromise({
        try: async () => await native.scan(review),
        catch: (cause) =>
          new DocumentScannerError({ message: "The scan failed", cause }),
      });
};

/**
 * Binds `pages`, in order, into one PDF whose file is called `name`, which
 * the share sheet shows and a saved copy keeps. It goes with the files of
 * `review`, whose pages they must be.
 */
export const buildPdf = async (
  review: string,
  name: string,
  pages: readonly PdfPage[],
): Promise<Result<BuiltPdf, DocumentScannerError>> => {
  const native = scanner;
  return native === null
    ? Result.err(
        new DocumentScannerError({
          message: "This build has no document scanner",
        }),
      )
    : await Result.tryPromise({
        try: async () => await native.buildPdf(review, name, pages),
        catch: (cause) =>
          new DocumentScannerError({
            message: "The PDF could not be made",
            cause,
          }),
      });
};

/** Removes every page and PDF the scanner wrote for `review`, once the person is done with them. */
export const discardScans = (review: string): void => {
  scanner?.discard(review);
};
