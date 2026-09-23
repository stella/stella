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
 * - `readStoredFile` (`stored-file.ts`): bytes it reads itself from a `FileKey`. Objects reach a file key
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
  | { type: "stored"; key: FileKey }
  | { type: "publisher"; adapterKey: string }
  /** folio re-serialized a `ScannedFile` (tracked changes resolved, edits applied). */
  | { type: "derived"; from: ScannedFileSource };

type ScannedFileFields = {
  bytes: ArrayBuffer;
  mimeType: string;
  fileName: string;
  source: ScannedFileSource;
};

let mint: (fields: ScannedFileFields) => ScannedFile;

/**
 * Mints a `ScannedFile`. Only `scan-upload.ts`, `stored-file.ts`,
 * `publisher-document.ts`, `document-parsers.ts`, and the test helper may
 * import this (enforced by `scanned-file-boundary`); it lives apart
 * from the scanner so stored-file readers do not bundle the scanner's native
 * addon.
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

  /**
   * The scanned bytes. `scanUpload` copied them out of the caller's buffer and
   * `readStoredFile` read them fresh, so no one else holds this buffer; parsers
   * must treat it as read-only.
   */
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
