import { requireOptionalNativeModule } from "expo";

/** A scan the document camera wrote: a PDF in the app's temporary files. */
export type ScannedDocument = {
  readonly uri: string;
  readonly pageCount: number;
  /** Bytes, and the SHA-256 in lowercase hex: what an upload is signed for. */
  readonly size: number;
  readonly sha256Hex: string;
};

type DocumentScannerModule = {
  readonly isSupported: () => boolean;
  /** Null when the person closed the camera without saving. */
  readonly scan: () => Promise<ScannedDocument | null>;
};

// Absent on Android, the web and a client built before the scanner.
const scanner =
  requireOptionalNativeModule<DocumentScannerModule>("DocumentScanner");

/** Whether this device can scan: it has the document camera, and the build has the scanner. */
export const canScan = (): boolean => scanner?.isSupported() ?? false;

/**
 * Opens the system document camera. It finds each page's edges and
 * straightens it as it captures; the pages come back as one PDF.
 */
export const scanDocument = async (): Promise<ScannedDocument | null> =>
  scanner === null ? null : await scanner.scan();
