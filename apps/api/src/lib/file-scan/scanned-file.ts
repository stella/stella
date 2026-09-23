/**
 * Proof that document bytes may reach a parser.
 *
 * Text extraction, PDF conversion, the PDF and OCR workers, and the folio-core
 * parsers take a `ScannedFile`, never raw bytes. The class has a private
 * constructor and an ES private field, so an object literal, a spread copy, or
 * `new ScannedFile(...)` cannot stand in for one; the only ways to hold one are:
 *
 * - `scanUpload` (`scan-upload.ts`): bytes that passed the security scan (verdict not `reject`).
 *   Server-built output (filled templates, reports) is scanned the same way.
 * - `storedFile`: bytes read back from a `FileKey`. Objects reach a file key
 *   only after a scan (upload finalize, direct upload, version writes, chat
 *   attachments) or as server-built derivatives of such objects (PDF and OCR
 *   renditions). Presigned staging keys are plain strings, so a raw upload
 *   cannot be passed off as stored.
 *
 * A cast to `ScannedFile` or `FileKey` is the remaining forgery path; the
 * `scanned-file-boundary` lint rule rejects it outside the owning modules.
 */
import type { FileKey } from "@/api/lib/file-key";
import type { ScanResult } from "@/api/lib/file-scan/types";

type ScannedFileSource =
  | { type: "scan"; scan: ScanResult; warnings: string[] | null }
  | { type: "stored"; key: FileKey };

type ScannedFileFields = {
  bytes: ArrayBuffer;
  mimeType: string;
  fileName: string;
  source: ScannedFileSource;
};

let mint: (fields: ScannedFileFields) => ScannedFile;

/**
 * Mints a `ScannedFile` from a completed scan. Only `scan-upload.ts` may
 * import this (enforced by `scanned-file-boundary`); it lives here so modules
 * that only read stored files do not pull the scanner and its native addon
 * into their bundle.
 */
export const mintScannedFile = (fields: ScannedFileFields): ScannedFile =>
  mint(fields);

export class ScannedFile {
  // An ES private field makes the type nominal: TypeScript only accepts
  // values constructed by this class, and spreading an instance drops it.
  readonly #bytes: ArrayBuffer;
  readonly mimeType: string;
  readonly fileName: string;
  readonly source: ScannedFileSource;

  private constructor({
    bytes,
    mimeType,
    fileName,
    source,
  }: ScannedFileFields) {
    this.#bytes = bytes;
    this.mimeType = mimeType;
    this.fileName = fileName;
    this.source = source;
  }

  static {
    mint = (fields) => new ScannedFile(fields);
  }

  get bytes(): ArrayBuffer {
    return this.#bytes;
  }

  /** Warnings to persist beside the stored file, or null when there are none. */
  get scanWarnings(): string[] | null {
    return this.source.type === "scan" ? this.source.warnings : null;
  }

  /** The same bytes under a different declared type (after MIME resolution). */
  withMimeType(mimeType: string): ScannedFile {
    return mint({
      bytes: this.#bytes,
      fileName: this.fileName,
      mimeType,
      source: this.source,
    });
  }
}

/** Copies only when the view does not span its whole buffer. */
export const toArrayBuffer = (bytes: ArrayBuffer | Uint8Array): ArrayBuffer => {
  if (bytes instanceof ArrayBuffer) {
    return bytes;
  }
  const whole =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength;
  return whole ? bytes.buffer : new Uint8Array(bytes).buffer;
};

type StoredFileInput = {
  key: FileKey;
  bytes: ArrayBuffer | Uint8Array;
  mimeType: string;
  fileName?: string;
};

/** Bytes read back from a file key, which only holds scanned or server-built output. */
export const storedFile = ({
  key,
  bytes,
  mimeType,
  fileName = key,
}: StoredFileInput): ScannedFile =>
  mint({
    bytes: toArrayBuffer(bytes),
    fileName,
    mimeType,
    source: { type: "stored", key },
  });
