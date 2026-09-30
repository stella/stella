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
import { Result, TaggedError } from "better-result";
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
    | "total-too-large"
    | "invalid-entry-name";
  cause?: unknown;
}> {}

export type ArchiveOptions = {
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

type ReadEntryOptions = {
  maxEntryBytes: number;
  remainingBytes: number;
  onChunk?: (chunk: Uint8Array) => void;
};

const readEntryBounded = async (
  entry: JSZip.JSZipObject,
  { maxEntryBytes, remainingBytes, onChunk }: ReadEntryOptions,
): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const stream = entry.internalStream("uint8array");
    let bytes = 0;
    let settled = false;
    stream.on("data", (chunk) => {
      if (settled) {
        return;
      }
      bytes += chunk.byteLength;
      if (bytes > maxEntryBytes || bytes > remainingBytes) {
        settled = true;
        stream.pause();
        reject(
          new DocxArchiveError({
            message: "DOCX entry exceeds its decompression budget",
            reason:
              bytes > maxEntryBytes ? "entry-too-large" : "total-too-large",
          }),
        );
        return;
      }
      onChunk?.(chunk);
    });
    stream.on("error", (cause) => {
      if (!settled) {
        settled = true;
        reject(
          new DocxArchiveError({
            message: "Failed to read DOCX entry",
            reason: "load-failed",
            cause,
          }),
        );
      }
    });
    stream.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(bytes);
      }
    });
    stream.resume();
  });

const loadDocxResult = async (
  buffer: ArrayBuffer | Uint8Array | Buffer,
  options: ArchiveOptions = {},
): Promise<Result<JSZip, DocxArchiveError>> => {
  const maxEntryBytes = options.maxEntryBytes ?? DOCX_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DOCX_MAX_TOTAL_BYTES;
  const maxEntries = options.maxEntries ?? DOCX_MAX_ENTRIES;

  if (buffer.byteLength > DOCX_MAX_TOTAL_BYTES) {
    return Result.err(
      new DocxArchiveError({
        message: "DOCX archive exceeds the input byte limit",
        reason: "total-too-large",
      }),
    );
  }
  const loaded = await Result.tryPromise({
    try: async () => await JSZip.loadAsync(buffer),
    catch: (cause) =>
      new DocxArchiveError({
        message: "Failed to parse DOCX archive",
        reason: "load-failed",
        cause,
      }),
  });
  if (Result.isError(loaded)) {
    return loaded;
  }
  const zip = loaded.value;

  const declaredEntries = Object.keys(zip.files).length;
  if (declaredEntries > maxEntries) {
    return Result.err(
      new DocxArchiveError({
        message: `DOCX archive declares ${declaredEntries} entries (max ${maxEntries})`,
        reason: "too-many-entries",
      }),
    );
  }

  // JSZip owns ZIP parsing; declared sizes reject excessive work before inflation.
  let declaredTotal = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) {
      continue;
    }
    const originalName = entry.unsafeOriginalName ?? entry.name;
    if (
      originalName.startsWith("/") ||
      /^[a-z]:/iu.test(originalName) ||
      originalName.includes("\\") ||
      originalName.split("/").includes("..")
    ) {
      return Result.err(
        new DocxArchiveError({
          message: "DOCX archive contains an invalid entry name",
          reason: "invalid-entry-name",
        }),
      );
    }
    const data = "_data" in entry ? entry._data : undefined;
    const declared =
      typeof data === "object" && data !== null && "uncompressedSize" in data
        ? data.uncompressedSize
        : undefined;
    // JSZip represents empty files without compressed-size metadata.
    // The streaming budget remains authoritative for every entry.
    if (declared === undefined) {
      continue;
    }
    if (
      typeof declared !== "number" ||
      !Number.isSafeInteger(declared) ||
      declared < 0
    ) {
      return Result.err(
        new DocxArchiveError({
          message: "DOCX archive contains invalid entry metadata",
          reason: "load-failed",
        }),
      );
    }
    if (declared > maxEntryBytes) {
      return Result.err(
        new DocxArchiveError({
          message: `DOCX entry "${entry.name}" declares ${declared} bytes (max ${maxEntryBytes})`,
          reason: "entry-too-large",
        }),
      );
    }
    declaredTotal += declared;
  }
  if (declaredTotal > maxTotalBytes) {
    return Result.err(
      new DocxArchiveError({
        message: `DOCX archive declares ${declaredTotal} cumulative uncompressed bytes (max ${maxTotalBytes})`,
        reason: "total-too-large",
      }),
    );
  }

  let validatedBytes = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) {
      continue;
    }
    const remainingBytes = maxTotalBytes - validatedBytes;
    const read = await Result.tryPromise({
      try: async () =>
        await readEntryBounded(entry, {
          maxEntryBytes,
          remainingBytes,
        }),
      catch: (cause) =>
        cause instanceof DocxArchiveError
          ? cause
          : new DocxArchiveError({
              message: "Failed to read DOCX entry",
              reason: "load-failed",
              cause,
            }),
    });
    if (Result.isError(read)) {
      return read;
    }
    validatedBytes += read.value;
  }
  return Result.ok(zip);
};

/** Load and validate an archive, preserving the promise-based ZIP API. */
export const loadDocx = async (
  buffer: ArrayBuffer | Uint8Array | Buffer,
  options: ArchiveOptions = {},
): Promise<JSZip> => (await loadDocxResult(buffer, options)).unwrap();

export const loadDocxArchive = async (
  buffer: ArrayBuffer | Uint8Array | Buffer,
  options: ArchiveOptions = {},
): Promise<DocxArchive> => {
  const maxEntryBytes = options.maxEntryBytes ?? DOCX_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DOCX_MAX_TOTAL_BYTES;
  const zip = await loadDocx(buffer, options);

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
      const chunks: Uint8Array[] = [];
      const size = await readEntryBounded(entry, {
        maxEntryBytes,
        remainingBytes: remaining,
        onChunk: (chunk) => chunks.push(chunk),
      });
      totalRead += size;
      return Buffer.concat(chunks, size);
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
