/**
 * Bounded reads of OOXML archives (DOCX, XLSX, PPTX) for the API.
 *
 * `ZipArchive.read` checks every size, name and record an archive declares
 * before anything inflates, and each entry inflates no further than its
 * declared size. The limits here are the API's policy on top of that.
 */
import { Result, TaggedError } from "better-result";

import { ZipArchive, ZipError, type ZipErrorReason } from "@stll/docx-core/zip";
import { declareFingerprintFields } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** Maximum bytes any single archive entry may decompress to. */
export const DOCX_MAX_ENTRY_BYTES = 128 * 1024 * 1024;

/** Maximum cumulative uncompressed bytes the archive may yield. */
const DOCX_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Maximum number of entries an archive may declare. Real DOCX/XLSX
 * documents have well under 200; orders of magnitude above that
 * indicate a hostile archive.
 */
export const DOCX_MAX_ENTRIES = 4096;

/**
 * Inflated bytes allowed per compressed byte for a markup entry, and for the
 * archive as a whole, once either passes 4 MiB. Binary parts (an uncompressed
 * bitmap of one colour) can legitimately compress further; the byte limits
 * bound them.
 */
const MAX_MARKUP_COMPRESSION_RATIO = 200;
const COMPRESSION_RATIO_GRACE_BYTES = 4 * 1024 * 1024;
const MARKUP_EXTENSIONS: ReadonlySet<string> = new Set([
  "xml",
  "rels",
  "vml",
  "txt",
  "htm",
  "html",
]);

export class DocxArchiveError extends TaggedError("DocxArchiveError")<{
  message: string;
  reason:
    | "load-failed"
    | "too-many-entries"
    | "entry-too-large"
    | "total-too-large"
    | "compression-ratio-exceeded"
    | "invalid-entry-name";
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type ArchiveOptions = {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
};

export type DocxArchive = {
  /** The archive. Entry reads stay within its declared sizes. */
  zip: ZipArchive;
  /**
   * Read an entry as UTF-8 text. Returns null if the entry is not in
   * the archive. Throws `DocxArchiveError` if the read would cross
   * the cumulative archive cap.
   */
  readEntryString: (path: string) => Promise<string | null>;
  /** As {@link readEntryString} but returns the raw bytes. */
  readEntryUint8: (path: string) => Promise<Uint8Array | null>;
};

const REASONS = {
  malformed: "load-failed",
  unsupported: "load-failed",
  "duplicate-entry": "load-failed",
  "corrupt-entry": "load-failed",
  "invalid-entry-name": "invalid-entry-name",
  "too-many-entries": "too-many-entries",
  "entry-too-large": "entry-too-large",
  "declared-size-exceeded": "entry-too-large",
  "total-too-large": "total-too-large",
  "compression-ratio": "compression-ratio-exceeded",
} as const satisfies Record<ZipErrorReason, DocxArchiveError["reason"]>;

const toArchiveError = (cause: unknown): DocxArchiveError =>
  cause instanceof DocxArchiveError
    ? cause
    : new DocxArchiveError({
        message:
          cause instanceof ZipError
            ? cause.message
            : "Failed to parse DOCX archive",
        reason:
          cause instanceof ZipError ? REASONS[cause.reason] : "load-failed",
        cause,
      });

const isMarkup = (path: string): boolean =>
  MARKUP_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());

/**
 * Open an archive within the API's limits and inflate every entry once, so
 * a corrupt or mis-declared entry is refused here rather than at a later
 * read. Rejects with `DocxArchiveError`.
 */
export const loadDocx = async (
  buffer: ArrayBuffer | Uint8Array,
  options: ArchiveOptions = {},
): Promise<ZipArchive> => {
  const maxTotalBytes = options.maxTotalBytes ?? DOCX_MAX_TOTAL_BYTES;
  if (buffer.byteLength > DOCX_MAX_TOTAL_BYTES) {
    throw new DocxArchiveError({
      message: "DOCX archive exceeds the input byte limit",
      reason: "total-too-large",
    });
  }
  const loaded = await Result.tryPromise({
    try: async () => {
      const zip = await ZipArchive.read(buffer, {
        limits: {
          maxEntries: options.maxEntries ?? DOCX_MAX_ENTRIES,
          maxEntryBytes: options.maxEntryBytes ?? DOCX_MAX_ENTRY_BYTES,
          maxTotalBytes,
          maxCompressionRatio: MAX_MARKUP_COMPRESSION_RATIO,
          compressionRatioGraceBytes: COMPRESSION_RATIO_GRACE_BYTES,
        },
        isCompressionRatioExempt: (path) => !isMarkup(path),
      });
      for (const entry of zip.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one entry in memory at a time
        await entry.bytes();
      }
      return zip;
    },
    catch: toArchiveError,
  });
  if (Result.isError(loaded)) {
    throw loaded.error;
  }
  return loaded.value;
};

/**
 * Open an archive with {@link loadDocx} and read entries through a running
 * total, so repeated reads stay within `maxTotalBytes` too.
 */
export const loadDocxArchive = async (
  buffer: ArrayBuffer | Uint8Array,
  options: ArchiveOptions = {},
): Promise<DocxArchive> => {
  const maxTotalBytes = options.maxTotalBytes ?? DOCX_MAX_TOTAL_BYTES;
  const zip = await loadDocx(buffer, options);
  let totalRead = 0;

  const readEntry = async (path: string): Promise<Uint8Array | null> => {
    const entry = zip.entry(path);
    if (!entry) {
      return null;
    }
    if (totalRead + entry.size > maxTotalBytes) {
      throw new DocxArchiveError({
        message: "DOCX entry exceeds its decompression budget",
        reason: "total-too-large",
      });
    }
    totalRead += entry.size;
    const bytes = await Result.tryPromise({
      try: async () => await entry.bytes(),
      catch: toArchiveError,
    });
    if (Result.isError(bytes)) {
      totalRead -= entry.size;
      throw bytes.error;
    }
    return bytes.value;
  };

  return {
    zip,
    async readEntryString(path) {
      const bytes = await readEntry(path);
      return bytes === null
        ? null
        : new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    },
    readEntryUint8: readEntry,
  };
};

/** Validate archive bytes before handing them to a document parser. */
export const validateDocxArchive = async (
  bytes: ArrayBuffer | Uint8Array,
  options: ArchiveOptions = {},
): Promise<Result<void, HandlerError<422>>> =>
  (
    await Result.tryPromise({
      try: async () => await loadDocx(bytes, options),
      catch: (cause) =>
        new HandlerError({
          status: 422,
          message: "Invalid archive",
          cause,
        }),
    })
  ).map(() => undefined);
