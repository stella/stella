/** Bounded metadata validation and sequential reads over OOXML archives. */
import { Result, TaggedError } from "better-result";
import JSZip from "jszip";

// JSZip's platform-neutral entry stream is missing from its published typings.
declare module "jszip" {
  type JSZipObject = {
    internalStream: (type: "uint8array") => JSZip.JSZipStreamHelper<Uint8Array>;
  };
}

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

type PreflightLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
};

const invalid = () =>
  Result.err(
    new DocxArchiveError({
      message: "DOCX archive contains invalid entry metadata",
      reason: "load-failed",
    }),
  );
const limitError = (reason: DocxArchiveError["reason"]) =>
  Result.err(
    new DocxArchiveError({
      message: "DOCX archive exceeds its budget",
      reason,
    }),
  );
type DirectoryMetadata = {
  count: bigint;
  diskCount: bigint;
  size: bigint;
  start: bigint;
  directoryEnd: number;
};
const readZip64Directory = (
  view: DataView,
  locator: number,
): Result<DirectoryMetadata, DocxArchiveError> => {
  if (
    view.getUint32(locator, true) !== 0x07_06_4b_50 ||
    view.getUint32(locator + 4, true) !== 0 ||
    view.getUint32(locator + 16, true) !== 1
  ) {
    return invalid();
  }
  const recordOffset = view.getBigUint64(locator + 8, true);
  if (recordOffset > BigInt(locator - 56)) {
    return invalid();
  }
  const record = Number(recordOffset);
  if (
    record < 0 ||
    record + 56 > view.byteLength ||
    view.getUint32(record, true) !== 0x06_06_4b_50 ||
    view.getBigUint64(record + 4, true) !== 44n ||
    record + 56 !== locator
  ) {
    return invalid();
  }
  // JSZip supports the fixed ZIP64 record; extensible records are not accepted.
  if (
    view.getUint32(record + 16, true) !== 0 ||
    view.getUint32(record + 20, true) !== 0
  ) {
    return invalid();
  }
  const zipCount = view.getBigUint64(record + 32, true);
  const zipDiskCount = view.getBigUint64(record + 24, true);
  const zipSize = view.getBigUint64(record + 40, true);
  const zipStart = view.getBigUint64(record + 48, true);
  return Result.ok({
    count: zipCount,
    diskCount: zipDiskCount,
    size: zipSize,
    start: zipStart,
    directoryEnd: record,
  });
};
const readDirectory = (
  view: DataView,
): Result<DirectoryMetadata, DocxArchiveError> => {
  let end = view.byteLength - 22;
  const earliest = Math.max(0, view.byteLength - 65_535 - 22);
  for (; end >= earliest; end--) {
    if (view.getUint32(end, true) === 0x06_05_4b_50) {
      break;
    }
  }
  if (
    end < earliest ||
    end + 22 + view.getUint16(end + 20, true) !== view.byteLength
  ) {
    return invalid();
  }
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0
  ) {
    return invalid();
  }
  let count = BigInt(view.getUint16(end + 10, true));
  let diskCount = BigInt(view.getUint16(end + 8, true));
  let size = BigInt(view.getUint32(end + 12, true));
  let start = BigInt(view.getUint32(end + 16, true));
  let directoryEnd = end;
  const locator = end - 20;
  const hasLocator =
    locator >= 0 && view.getUint32(locator, true) === 0x07_06_4b_50;
  const needsZip64 =
    count === 65_535n ||
    diskCount === 65_535n ||
    size === 0xff_ff_ff_ffn ||
    start === 0xff_ff_ff_ffn;
  if (needsZip64 || hasLocator) {
    if (!hasLocator) {
      return invalid();
    }
    const zip64 = readZip64Directory(view, locator);
    if (Result.isError(zip64)) {
      return zip64;
    }
    const actual = zip64.value;
    const fields = [
      [count, actual.count, 65_535n],
      [diskCount, actual.diskCount, 65_535n],
      [size, actual.size, 0xff_ff_ff_ffn],
      [start, actual.start, 0xff_ff_ff_ffn],
    ];
    if (
      fields.some(
        ([declared, value, sentinel]) =>
          declared !== sentinel && declared !== value,
      )
    ) {
      return invalid();
    }
    ({ count, diskCount, size, start, directoryEnd } = actual);
  }
  if (
    count !== diskCount ||
    start + size !== BigInt(directoryEnd) ||
    start > BigInt(directoryEnd)
  ) {
    return invalid();
  }
  return Result.ok({ count, diskCount, size, start, directoryEnd });
};
type EntrySizes = { declared: bigint; compressed: bigint; localOffset: bigint };
type EntrySizeOptions = {
  view: DataView;
  offset: number;
  extraStart: number;
  extraEndOffset: number;
};
const readEntrySizes = ({
  view,
  offset,
  extraStart,
  extraEndOffset,
}: EntrySizeOptions): Result<EntrySizes, DocxArchiveError> => {
  let declared = BigInt(view.getUint32(offset + 24, true));
  let compressed = BigInt(view.getUint32(offset + 20, true));
  let localOffset = BigInt(view.getUint32(offset + 42, true));
  let extra = extraStart;

  let zip64Seen = false;
  while (extra < extraEndOffset) {
    if (extra + 4 > extraEndOffset) {
      return invalid();
    }
    const tag = view.getUint16(extra, true);
    const length = view.getUint16(extra + 2, true);
    const payload = extra + 4;
    if (payload + length > extraEndOffset) {
      return invalid();
    }
    if (tag === 1) {
      if (zip64Seen) {
        return invalid();
      }
      zip64Seen = true;
      const required =
        (declared === 0xff_ff_ff_ffn ? 8 : 0) +
        (compressed === 0xff_ff_ff_ffn ? 8 : 0) +
        (localOffset === 0xff_ff_ff_ffn ? 8 : 0);
      if (length < required) {
        return invalid();
      }
      let field = payload;
      if (declared === 0xff_ff_ff_ffn) {
        declared = view.getBigUint64(field, true);
        field += 8;
      }
      if (compressed === 0xff_ff_ff_ffn) {
        compressed = view.getBigUint64(field, true);
        field += 8;
      }
      if (localOffset === 0xff_ff_ff_ffn) {
        localOffset = view.getBigUint64(field, true);
      }
    }
    extra = payload + length;
  }
  if (
    !zip64Seen &&
    (declared === 0xff_ff_ff_ffn ||
      compressed === 0xff_ff_ff_ffn ||
      localOffset === 0xff_ff_ff_ffn)
  ) {
    return invalid();
  }
  return Result.ok({ declared, compressed, localOffset });
};
type EntryMetadata = {
  next: number;
  name: string;
  declared: bigint;
  directory: boolean;
};
type EntryMetadataOptions = {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  start: bigint;
  directoryEnd: number;
};
const readEntryMetadata = ({
  bytes,
  view,
  offset,
  start,
  directoryEnd,
}: EntryMetadataOptions): Result<EntryMetadata, DocxArchiveError> => {
  if (
    offset + 46 > directoryEnd ||
    view.getUint32(offset, true) !== 0x02_01_4b_50
  ) {
    return invalid();
  }
  const nameLength = view.getUint16(offset + 28, true);
  const extraLength = view.getUint16(offset + 30, true);
  const commentLength = view.getUint16(offset + 32, true);
  const next = offset + 46 + nameLength + extraLength + commentLength;
  if (
    next > directoryEnd ||
    nameLength === 0 ||
    view.getUint16(offset + 34, true) !== 0
  ) {
    return invalid();
  }
  const name = Buffer.from(
    bytes.subarray(offset + 46, offset + 46 + nameLength),
  ).toString("hex");
  const sizes = readEntrySizes({
    view,
    offset,
    extraStart: offset + 46 + nameLength,
    extraEndOffset: offset + 46 + nameLength + extraLength,
  });
  if (Result.isError(sizes)) {
    return sizes;
  }
  const { declared, compressed, localOffset } = sizes.value;
  if (compressed > start || localOffset + 30n > start) {
    return invalid();
  }
  const local = Number(localOffset);
  if (
    local < 0 ||
    local + 30 > bytes.length ||
    view.getUint32(local, true) !== 0x04_03_4b_50
  ) {
    return invalid();
  }
  const localNameLength = view.getUint16(local + 26, true);
  const dataStart =
    localOffset +
    BigInt(30 + localNameLength + view.getUint16(local + 28, true));
  if (
    dataStart + compressed > start ||
    localNameLength !== nameLength ||
    Buffer.from(
      bytes.subarray(local + 30, local + 30 + localNameLength),
    ).toString("hex") !== name
  ) {
    return invalid();
  }
  const directory =
    bytes[offset + 46 + nameLength - 1] === 47 ||
    Math.floor(view.getUint32(offset + 38, true) / 16) % 2 === 1;
  return Result.ok({ next, name, declared, directory });
};
// Read only bounded metadata here; JSZip remains responsible for ZIP decoding.
const preflightArchive = (
  bytes: Uint8Array,
  { maxEntries, maxEntryBytes, maxTotalBytes }: PreflightLimits,
): Result<void, DocxArchiveError> => {
  if (
    [maxEntries, maxEntryBytes, maxTotalBytes].some(
      (limit) => !Number.isSafeInteger(limit) || limit < 0,
    )
  ) {
    return invalid();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadata = readDirectory(view);
  if (Result.isError(metadata)) {
    return metadata;
  }
  const { count, start, directoryEnd } = metadata.value;
  let offset = Number(start);
  let records = 0;
  let total = 0n;
  const names = new Set<string>();
  while (offset < directoryEnd) {
    if (++records > maxEntries) {
      return limitError("too-many-entries");
    }
    const entry = readEntryMetadata({
      bytes,
      view,
      offset,
      start,
      directoryEnd,
    });
    if (Result.isError(entry)) {
      return entry;
    }
    const { name, declared, directory, next } = entry.value;
    if (names.has(name)) {
      return invalid();
    }
    names.add(name);
    if (!directory) {
      if (declared > BigInt(maxEntryBytes)) {
        return limitError("entry-too-large");
      }
      total += declared;
      if (total > BigInt(maxTotalBytes)) {
        return limitError("total-too-large");
      }
    }
    offset = next;
  }
  if (BigInt(records) !== count) {
    return invalid();
  }
  return Result.ok();
};

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
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const preflight = preflightArchive(bytes, {
    maxEntries,
    maxEntryBytes,
    maxTotalBytes,
  });
  if (Result.isError(preflight)) {
    return preflight;
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
): Promise<JSZip> => {
  const result = await loadDocxResult(buffer, options);
  if (Result.isError(result)) {
    return await Promise.reject(result.error);
  }
  return result.value;
};

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
