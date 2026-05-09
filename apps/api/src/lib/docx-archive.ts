/**
 * Bounded reads over a DOCX (or any OOXML) archive.
 *
 * `JSZip.loadAsync` parses the archive's central directory cheaply, but
 * `entry.async("string")` and friends will happily inflate an entry to
 * any size the archive declares — a 1 KB file can decompress to many
 * gigabytes. The helpers below wrap that surface so each entry read
 * has both a per-entry cap and a per-archive cumulative cap, and an
 * archive that declares an unreasonable number of entries is rejected
 * upfront.
 */
import { TaggedError } from "better-result";
import JSZip from "jszip";

/** Maximum bytes any single archive entry may decompress to. */
export const DOCX_MAX_ENTRY_BYTES = 128 * 1024 * 1024;

/** Maximum cumulative uncompressed bytes the archive may yield. */
export const DOCX_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Maximum number of entries an archive may declare. Real DOCX/XLSX
 * documents have well under 200; orders of magnitude above that
 * indicate a hostile archive.
 */
export const DOCX_MAX_ENTRIES = 4096;

export class DocxArchiveError extends TaggedError("DocxArchiveError")<{
  message: string;
  reason:
    | "load-failed"
    | "too-many-entries"
    | "entry-too-large"
    | "total-too-large";
  cause?: unknown;
}>() {}

type ArchiveOptions = {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
};

export type DocxArchive = {
  /**
   * The underlying JSZip instance. Safe for write operations
   * (`zip.file(path, value)`, `zip.generateAsync(...)`); for reads,
   * prefer the bounded helpers on this object.
   */
  zip: JSZip;
  /**
   * Read an entry as UTF-8 text. Returns null if the entry is not in
   * the archive. Throws `DocxArchiveError` if the read would cross
   * the per-entry or cumulative archive cap.
   */
  readEntryString: (path: string) => Promise<string | null>;
  /** As {@link readEntryString} but returns the raw bytes. */
  readEntryUint8: (path: string) => Promise<Uint8Array | null>;
};

const collectStreamBounded = async (
  stream: NodeJS.ReadableStream,
  perEntryMax: number,
  remainingBudget: number,
  totalBudget: number,
  path: string,
): Promise<Buffer> =>
  await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let entryRead = 0;
    const fail = (
      reason: "entry-too-large" | "total-too-large",
      message: string,
    ) => {
      // `destroy` exists on Node Readables; JSZip returns one but the
      // type is the parent NodeJS.ReadableStream interface.
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      reject(new DocxArchiveError({ message, reason }));
    };
    stream.on("data", (chunk: Buffer | string) => {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      entryRead += piece.length;
      if (entryRead > perEntryMax) {
        fail(
          "entry-too-large",
          `DOCX entry "${path}" exceeded the ${perEntryMax}-byte single-entry limit`,
        );
        return;
      }
      if (entryRead > remainingBudget) {
        fail(
          "total-too-large",
          `DOCX archive exceeded the ${totalBudget}-byte cumulative decompression budget while reading "${path}"`,
        );
        return;
      }
      chunks.push(piece);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

export const loadDocxArchive = async (
  buffer: ArrayBuffer | Uint8Array | Buffer,
  options: ArchiveOptions = {},
): Promise<DocxArchive> => {
  const maxEntryBytes = options.maxEntryBytes ?? DOCX_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DOCX_MAX_TOTAL_BYTES;
  const maxEntries = options.maxEntries ?? DOCX_MAX_ENTRIES;

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new DocxArchiveError({
      message: "Failed to parse DOCX archive",
      reason: "load-failed",
      cause: error,
    });
  }

  const declaredEntries = Object.keys(zip.files).length;
  if (declaredEntries > maxEntries) {
    throw new DocxArchiveError({
      message: `DOCX archive declares ${declaredEntries} entries (max ${maxEntries})`,
      reason: "too-many-entries",
    });
  }

  // Pre-flight via JSZip's central-directory metadata so an obviously
  // hostile archive is rejected before a single byte is decompressed.
  // The `_data.uncompressedSize` property is internal; if a future
  // JSZip release moves it the pre-flight degrades to a no-op and the
  // streaming read caps below remain the authoritative defence.
  type EntryWithInternals = JSZip.JSZipObject & {
    _data?: { uncompressedSize?: unknown };
  };
  let declaredTotal = 0;
  for (const entry of Object.values(zip.files)) {
    const declared = (entry as EntryWithInternals)._data?.uncompressedSize;
    if (typeof declared !== "number" || !Number.isFinite(declared)) {
      declaredTotal = Number.NaN;
      break;
    }
    if (declared > maxEntryBytes) {
      throw new DocxArchiveError({
        message: `DOCX entry "${entry.name}" declares ${declared} bytes (max ${maxEntryBytes})`,
        reason: "entry-too-large",
      });
    }
    declaredTotal += declared;
  }
  if (Number.isFinite(declaredTotal) && declaredTotal > maxTotalBytes) {
    throw new DocxArchiveError({
      message: `DOCX archive declares ${declaredTotal} cumulative uncompressed bytes (max ${maxTotalBytes})`,
      reason: "total-too-large",
    });
  }

  let totalRead = 0;
  // Reads are serialised through this chain so the cumulative-budget
  // check and the `totalRead` increment are observed atomically by
  // each subsequent read. Concurrent callers each await the previous
  // read's outcome before attempting their own decompression. A
  // previous read failing must not break the chain for later reads —
  // they should still get a consistent budget snapshot.
  let readChain: Promise<unknown> = Promise.resolve();

  const readEntry = async (path: string): Promise<Buffer | null> => {
    const work = async (): Promise<Buffer | null> => {
      const entry = zip.file(path);
      if (!entry) {
        return null;
      }
      const remaining = maxTotalBytes - totalRead;
      const buf = await collectStreamBounded(
        entry.nodeStream("nodebuffer"),
        maxEntryBytes,
        remaining,
        maxTotalBytes,
        path,
      );
      totalRead += buf.length;
      return buf;
    };
    const next = readChain.then(work, work);
    readChain = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  };

  return {
    zip,
    async readEntryString(path) {
      const buf = await readEntry(path);
      return buf === null ? null : buf.toString("utf-8");
    },
    async readEntryUint8(path) {
      const buf = await readEntry(path);
      return buf === null ? null : new Uint8Array(buf);
    },
  };
};
