// Streaming ZIP writer for organisation data exports.
//
// `client-zip` (used by the folder download) stores every entry uncompressed;
// an export is mostly already-compressed documents plus a large amount of
// JSON and CSV, so each entry here picks STORED or DEFLATE.
//
// Two kinds of entry keep memory bounded. Small entries (records, manifests,
// small text documents) arrive as bytes: CRC and sizes are known before the
// local header, so they need no data descriptor and may be deflated. Large
// files arrive as a stream of chunks and are passed straight through STORED:
// the local header announces a data descriptor (flag bit 3) and the CRC and
// sizes follow the data. Every reader that uses the central directory (all
// desktop tools) handles both; only the size of one chunk is ever held.
//
// ZIP64 records are written only when a value overflows its 16- or 32-bit
// field (APPNOTE 6.3.10, sections 4.3.14 to 4.3.16 and 4.5.3).

import { panic, TaggedError } from "better-result";
import { promisify } from "node:util";
import { crc32 as zlibCrc32, deflateRaw } from "node:zlib";

import { Temporal } from "@stll/time";

export const ZIP_COMPRESSION = {
  STORE: "store",
  DEFLATE: "deflate",
} as const;

export type ZipCompression =
  (typeof ZIP_COMPRESSION)[keyof typeof ZIP_COMPRESSION];

type ZipEntrySource =
  | { type: "bytes"; data: Uint8Array; compression: ZipCompression }
  | {
      type: "stream";
      chunks: AsyncIterable<Uint8Array>;
      /** Exact length; a stream that ends at any other length is refused. */
      sizeBytes: number;
    };

export type ZipEntryInput = {
  /** Archive path with `/` separators; already sanitised by the caller. */
  name: string;
  modifiedAt: Date;
  source: ZipEntrySource;
};

/** A streamed entry ended at a length other than the one it announced. */
export class ZipStreamLengthError extends TaggedError("ZipStreamLengthError")<{
  message: string;
}> {}

const SIG_LOCAL_FILE = 0x04_03_4b_50;
const SIG_CENTRAL_DIRECTORY = 0x02_01_4b_50;
const SIG_END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;
const SIG_ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06_06_4b_50;
const SIG_ZIP64_LOCATOR = 0x07_06_4b_50;
const SIG_DATA_DESCRIPTOR = 0x08_07_4b_50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

// Bit 11: file name and comment are UTF-8 (APPNOTE appendix D).
export const FLAG_UTF8 = 0x08_00;
// Bit 3: CRC and sizes follow the data in a data descriptor.
export const FLAG_DATA_DESCRIPTOR = 0x00_08;
// Distinct bits, so adding them sets both.
const FLAGS_STREAMED = FLAG_UTF8 + FLAG_DATA_DESCRIPTOR;

const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
// Upper byte 3 = UNIX, so `external attributes` carry POSIX permissions.
// The header fields are packed with arithmetic (a shift by n is a multiply
// by 2^n), as the repository disallows bitwise operators.
const BYTE = 0x1_00;
const VERSION_MADE_BY = 3 * BYTE + VERSION_ZIP64;
// Regular file, mode 0644, in the upper 16 bits.
const UNIX_REGULAR_FILE_0644 = 0o10_0644 * 0x1_00_00;

const EXTRA_ZIP64 = 0x00_01;
const EXTRA_EXTENDED_TIMESTAMP = 0x54_55;

export const UINT16_MAX = 0xff_ff;
export const UINT32_MAX = 0xff_ff_ff_ff;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;
const EXTENDED_TIMESTAMP_SIZE = 9;

const textEncoder = new TextEncoder();

/** A size or offset no longer fits a 32-bit field; ZIP64 must carry it. */
const overflows32 = (value: number): boolean => value >= UINT32_MAX;

/** The entry count no longer fits the 16-bit EOCD field. */
const overflows16 = (value: number): boolean => value >= UINT16_MAX;

const writeUint64 = (view: DataView, offset: number, value: number): void => {
  view.setBigUint64(offset, BigInt(value), true);
};

const DOS_EPOCH_YEAR = 1980;
const DOS_LAST_YEAR = 2107;

// MS-DOS date/time fields carry no zone. They are written in UTC so the
// archive does not depend on the server's zone; the extended-timestamp extra
// field carries the exact instant for readers that understand it.
const toDosDateTime = (date: Date): { time: number; date: number } => {
  const utc = Temporal.Instant.fromEpochMilliseconds(
    date.getTime(),
  ).toZonedDateTimeISO("UTC");
  const year = Math.min(Math.max(utc.year, DOS_EPOCH_YEAR), DOS_LAST_YEAR);
  return {
    // hour << 11 | minute << 5 | second / 2
    time: utc.hour * 2048 + utc.minute * 32 + Math.floor(utc.second / 2),
    // (year - 1980) << 9 | month << 5 | day
    date: (year - DOS_EPOCH_YEAR) * 512 + utc.month * 32 + utc.day,
  };
};

const extendedTimestampExtra = (modifiedAt: Date): Uint8Array => {
  const bytes = new Uint8Array(EXTENDED_TIMESTAMP_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, EXTRA_EXTENDED_TIMESTAMP, true);
  view.setUint16(2, 5, true);
  // Flag bit 0: modification time present.
  view.setUint8(4, 1);
  const seconds = Math.floor(modifiedAt.getTime() / 1000);
  view.setUint32(5, Math.min(Math.max(seconds, 0), UINT32_MAX), true);
  return bytes;
};

/** ZIP64 extended information: only the overflowing fields, in spec order. */
const zip64Extra = (fields: readonly number[]): Uint8Array => {
  if (fields.length === 0) {
    return new Uint8Array(0);
  }
  const bytes = new Uint8Array(4 + fields.length * 8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, EXTRA_ZIP64, true);
  view.setUint16(2, fields.length * 8, true);
  for (const [index, value] of fields.entries()) {
    writeUint64(view, 4 + index * 8, value);
  }
  return bytes;
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let length = 0;
  for (const part of parts) {
    length += part.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

type EncodedEntry = {
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  dos: { time: number; date: number };
  timestampExtra: Uint8Array;
};

type CentralRecord = EncodedEntry & { localHeaderOffset: number };

const encodeName = (name: string): Uint8Array => {
  const nameBytes = textEncoder.encode(name);
  // Callers allocate names from sanitised segments of at most 255 characters
  // each, far inside the field.
  if (nameBytes.byteLength > UINT16_MAX) {
    return panic("ZIP entry name exceeds 65535 bytes");
  }
  return nameBytes;
};

const deflate = promisify(deflateRaw);

const encodeBytesEntry = async (
  name: string,
  modifiedAt: Date,
  { data, compression }: { data: Uint8Array; compression: ZipCompression },
): Promise<{ encoded: EncodedEntry; payload: Uint8Array }> => {
  let method = METHOD_STORE;
  let payload = data;
  if (compression === ZIP_COMPRESSION.DEFLATE) {
    const deflated = await deflate(data);
    // Incompressible input stays STORED: never ship an entry larger than its
    // own content.
    if (deflated.byteLength < data.byteLength) {
      method = METHOD_DEFLATE;
      payload = deflated;
    }
  }
  return {
    encoded: {
      nameBytes: encodeName(name),
      flags: FLAG_UTF8,
      method,
      crc32: Bun.hash.crc32(data),
      compressedSize: payload.byteLength,
      uncompressedSize: data.byteLength,
      dos: toDosDateTime(modifiedAt),
      timestampExtra: extendedTimestampExtra(modifiedAt),
    },
    payload,
  };
};

type LocalHeaderFields = EncodedEntry & {
  /** A streamed entry whose sizes need the ZIP64 field. */
  streamedZip64: boolean;
};

const localHeader = (entry: LocalHeaderFields): Uint8Array => {
  const needsZip64 =
    entry.streamedZip64 ||
    overflows32(entry.compressedSize) ||
    overflows32(entry.uncompressedSize);
  // The local ZIP64 field carries both sizes whenever either overflows
  // (APPNOTE 4.5.3); a streamed entry writes zeros there and the real sizes
  // in its data descriptor.
  const zip64 = needsZip64
    ? zip64Extra([entry.uncompressedSize, entry.compressedSize])
    : new Uint8Array(0);
  const header = new Uint8Array(LOCAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, SIG_LOCAL_FILE, true);
  view.setUint16(4, needsZip64 ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  view.setUint16(6, entry.flags, true);
  view.setUint16(8, entry.method, true);
  view.setUint16(10, entry.dos.time, true);
  view.setUint16(12, entry.dos.date, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, needsZip64 ? UINT32_MAX : entry.compressedSize, true);
  view.setUint32(22, needsZip64 ? UINT32_MAX : entry.uncompressedSize, true);
  view.setUint16(26, entry.nameBytes.byteLength, true);
  view.setUint16(28, zip64.byteLength + entry.timestampExtra.byteLength, true);
  return concat([header, entry.nameBytes, zip64, entry.timestampExtra]);
};

/** The data descriptor that follows a streamed entry (APPNOTE 4.3.9). */
export const dataDescriptor = ({
  crc32,
  sizeBytes,
  zip64,
}: {
  crc32: number;
  sizeBytes: number;
  zip64: boolean;
}): Uint8Array => {
  const sizeWidth = zip64 ? 8 : 4;
  const bytes = new Uint8Array(8 + sizeWidth * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, SIG_DATA_DESCRIPTOR, true);
  view.setUint32(4, crc32, true);
  if (zip64) {
    writeUint64(view, 8, sizeBytes);
    writeUint64(view, 16, sizeBytes);
  } else {
    view.setUint32(8, sizeBytes, true);
    view.setUint32(12, sizeBytes, true);
  }
  return bytes;
};

/** One central directory file header; exported for boundary tests. */
export const centralDirectoryHeader = (record: CentralRecord): Uint8Array => {
  const zip64Fields: number[] = [];
  if (overflows32(record.uncompressedSize)) {
    zip64Fields.push(record.uncompressedSize);
  }
  if (overflows32(record.compressedSize)) {
    zip64Fields.push(record.compressedSize);
  }
  if (overflows32(record.localHeaderOffset)) {
    zip64Fields.push(record.localHeaderOffset);
  }
  const zip64 = zip64Extra(zip64Fields);
  const header = new Uint8Array(CENTRAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, SIG_CENTRAL_DIRECTORY, true);
  view.setUint16(4, VERSION_MADE_BY, true);
  view.setUint16(
    6,
    zip64Fields.length > 0 ? VERSION_ZIP64 : VERSION_DEFAULT,
    true,
  );
  view.setUint16(8, record.flags, true);
  view.setUint16(10, record.method, true);
  view.setUint16(12, record.dos.time, true);
  view.setUint16(14, record.dos.date, true);
  view.setUint32(16, record.crc32, true);
  view.setUint32(20, Math.min(record.compressedSize, UINT32_MAX), true);
  view.setUint32(24, Math.min(record.uncompressedSize, UINT32_MAX), true);
  view.setUint16(28, record.nameBytes.byteLength, true);
  view.setUint16(30, zip64.byteLength + record.timestampExtra.byteLength, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, UNIX_REGULAR_FILE_0644, true);
  view.setUint32(42, Math.min(record.localHeaderOffset, UINT32_MAX), true);
  return concat([header, record.nameBytes, zip64, record.timestampExtra]);
};

type EndOfArchiveArgs = {
  entryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
};

/** The end-of-archive records, with ZIP64 records only when needed. */
export const endOfArchive = ({
  entryCount,
  centralDirectoryOffset,
  centralDirectorySize,
}: EndOfArchiveArgs): Uint8Array => {
  const needsZip64 =
    overflows16(entryCount) ||
    overflows32(centralDirectoryOffset) ||
    overflows32(centralDirectorySize);
  const parts: Uint8Array[] = [];
  if (needsZip64) {
    const record = new Uint8Array(ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, SIG_ZIP64_END_OF_CENTRAL_DIRECTORY, true);
    // Size of the remaining record, excluding the leading 12 bytes.
    writeUint64(recordView, 4, ZIP64_END_OF_CENTRAL_DIRECTORY_SIZE - 12);
    recordView.setUint16(12, VERSION_MADE_BY, true);
    recordView.setUint16(14, VERSION_ZIP64, true);
    recordView.setUint32(16, 0, true);
    recordView.setUint32(20, 0, true);
    writeUint64(recordView, 24, entryCount);
    writeUint64(recordView, 32, entryCount);
    writeUint64(recordView, 40, centralDirectorySize);
    writeUint64(recordView, 48, centralDirectoryOffset);
    parts.push(record);

    const locator = new Uint8Array(ZIP64_LOCATOR_SIZE);
    const locatorView = new DataView(locator.buffer);
    locatorView.setUint32(0, SIG_ZIP64_LOCATOR, true);
    locatorView.setUint32(4, 0, true);
    writeUint64(locatorView, 8, centralDirectoryOffset + centralDirectorySize);
    locatorView.setUint32(16, 1, true);
    parts.push(locator);
  }
  const end = new Uint8Array(END_OF_CENTRAL_DIRECTORY_SIZE);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, SIG_END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, Math.min(entryCount, UINT16_MAX), true);
  endView.setUint16(10, Math.min(entryCount, UINT16_MAX), true);
  endView.setUint32(12, Math.min(centralDirectorySize, UINT32_MAX), true);
  endView.setUint32(16, Math.min(centralDirectoryOffset, UINT32_MAX), true);
  endView.setUint16(20, 0, true);
  parts.push(end);
  return concat(parts);
};

/** What the writer reports for one entry once its bytes are emitted. */
export type WrittenZipEntry = {
  name: string;
  compression: ZipCompression;
  compressedSize: number;
  uncompressedSize: number;
};

type WriteZipOptions = {
  onEntry?: (entry: WrittenZipEntry) => void;
};

// Stream a ZIP archive. Each yielded chunk is ready to append to the output;
// the archive's total size is the sum of chunk lengths. Entry names must be
// unique (see `ArchivePathAllocator`); a duplicate is a caller bug.
export const writeZip = async function* (
  entries: AsyncIterable<ZipEntryInput> | Iterable<ZipEntryInput>,
  { onEntry }: WriteZipOptions = {},
): AsyncGenerator<Uint8Array> {
  const records: CentralRecord[] = [];
  const names = new Set<string>();
  let offset = 0;
  for await (const entry of entries) {
    if (names.has(entry.name)) {
      panic(`Duplicate ZIP entry name: ${entry.name}`);
    }
    names.add(entry.name);
    const localHeaderOffset = offset;
    const { source } = entry;
    switch (source.type) {
      case "bytes": {
        const { encoded, payload } = await encodeBytesEntry(
          entry.name,
          entry.modifiedAt,
          source,
        );
        const header = localHeader({ ...encoded, streamedZip64: false });
        records.push({ ...encoded, localHeaderOffset });
        yield header;
        yield payload;
        offset += header.byteLength + payload.byteLength;
        onEntry?.({
          name: entry.name,
          compression:
            encoded.method === METHOD_DEFLATE
              ? ZIP_COMPRESSION.DEFLATE
              : ZIP_COMPRESSION.STORE,
          compressedSize: encoded.compressedSize,
          uncompressedSize: encoded.uncompressedSize,
        });
        break;
      }
      case "stream": {
        const zip64 = overflows32(source.sizeBytes);
        const fields = {
          nameBytes: encodeName(entry.name),
          flags: FLAGS_STREAMED,
          method: METHOD_STORE,
          dos: toDosDateTime(entry.modifiedAt),
          timestampExtra: extendedTimestampExtra(entry.modifiedAt),
        };
        const header = localHeader({
          ...fields,
          crc32: 0,
          compressedSize: 0,
          uncompressedSize: 0,
          streamedZip64: zip64,
        });
        yield header;
        offset += header.byteLength;
        let crc = 0;
        let sizeBytes = 0;
        for await (const chunk of source.chunks) {
          crc = zlibCrc32(chunk, crc);
          sizeBytes += chunk.byteLength;
          yield chunk;
        }
        offset += sizeBytes;
        // The header already committed to a descriptor width; a different
        // length means the source changed under us and the part is unusable.
        if (sizeBytes !== source.sizeBytes) {
          throw new ZipStreamLengthError({
            message: `Streamed entry ${entry.name} ended at ${sizeBytes} of ${source.sizeBytes} bytes`,
          });
        }
        const descriptor = dataDescriptor({ crc32: crc, sizeBytes, zip64 });
        yield descriptor;
        offset += descriptor.byteLength;
        records.push({
          ...fields,
          crc32: crc,
          compressedSize: sizeBytes,
          uncompressedSize: sizeBytes,
          localHeaderOffset,
        });
        onEntry?.({
          name: entry.name,
          compression: ZIP_COMPRESSION.STORE,
          compressedSize: sizeBytes,
          uncompressedSize: sizeBytes,
        });
        break;
      }
      default:
        source satisfies never;
        panic("Unhandled ZIP entry source");
    }
  }
  const centralDirectoryOffset = offset;
  let centralDirectorySize = 0;
  for (const record of records) {
    const header = centralDirectoryHeader(record);
    centralDirectorySize += header.byteLength;
    yield header;
  }
  yield endOfArchive({
    entryCount: records.length,
    centralDirectoryOffset,
    centralDirectorySize,
  });
};
