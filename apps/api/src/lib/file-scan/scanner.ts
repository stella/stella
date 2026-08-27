export type Severity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "suspicious"
  | "malicious";

export type Match = {
  rule: string;
  severity?: Severity;
  meta?: Record<string, unknown>;
};

export type Scanner = {
  scan: (bytes: Uint8Array) => Promise<Match[]>;
};

export type ScanContext = {
  filename: string;
  mimeType: string;
};

export type ComposedScanner = (
  buffer: Uint8Array,
  ctx: ScanContext,
) => Promise<Match[]>;

export const composeScanners =
  (...scanners: Scanner[]): ComposedScanner =>
  async (buffer) => {
    const results = await Promise.all(
      scanners.map(async (s) => await s.scan(buffer)),
    );

    // An archive is presented to the rule set twice, as raw container bytes
    // and as inflated entries, so one rule can match in both passes. A rule
    // identifies a finding, so the first match for it wins.
    const byRule = new Map<string, Match>();
    for (const match of results.flat()) {
      if (!byRule.has(match.rule)) {
        byRule.set(match.rule, match);
      }
    }
    return [...byRule.values()];
  };

type ZipBombGuardOptions = {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
};

/** Local file header signature: PK\x03\x04 */
const LOCAL_FILE_HEADER = 0x04_03_4b_50;
/** Central directory file header signature: PK\x01\x02 */
const CENTRAL_FILE_HEADER = 0x02_01_4b_50;
/** End of central directory record signature: PK\x05\x06 */
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 0xff_ff;
/** Field value meaning "the real value lives in a ZIP64 extra field". */
const ZIP64_SIZE_SENTINEL = 0xff_ff_ff_ff;
const ZIP64_COUNT_SENTINEL = 0xff_ff;

const UNVERIFIABLE: Match = {
  rule: "zip-unverifiable",
  severity: "malicious",
  meta: {
    description:
      "ZIP entry sizes are not readable from the archive index, so " +
      "compression ratio and total uncompressed size cannot be checked",
  },
};

const tooManyEntries = (max: number): Match => ({
  rule: "zip-bomb-entries",
  severity: "critical",
  meta: { description: `ZIP contains more than ${max} entries` },
});

const ratioExceeded = (ratio: number, max: number): Match => ({
  rule: "zip-bomb-ratio",
  severity: "critical",
  meta: {
    description: `Entry has compression ratio ${ratio.toFixed(0)}:1 (limit: ${max}:1)`,
  },
});

const totalExceeded = (max: number): Match => ({
  rule: "zip-bomb-size",
  severity: "critical",
  meta: {
    description: `Total uncompressed size exceeds limit of ${max} bytes`,
  },
});

export const createZipBombGuard = (opts: ZipBombGuardOptions): Scanner => ({
  scan: async (bytes) => await Promise.resolve(scanZipBomb(bytes, opts)),
});

type CentralDirectory = { entryCount: number; offset: number };

/**
 * The record sits at the end of the archive, after a comment of up to 64 KiB,
 * so it is located by scanning backwards for its signature.
 */
const findCentralDirectory = (
  view: DataView,
  length: number,
): CentralDirectory | null => {
  const earliest = Math.max(0, length - EOCD_BYTES - MAX_ZIP_COMMENT_BYTES);
  for (let at = length - EOCD_BYTES; at >= earliest; at--) {
    if (view.getUint32(at, true) !== END_OF_CENTRAL_DIRECTORY) {
      continue;
    }
    return {
      entryCount: view.getUint16(at + 10, true),
      offset: view.getUint32(at + 16, true),
    };
  }
  return null;
};

/**
 * The central directory carries the real sizes for every entry, including
 * entries whose local header defers them to a trailing data descriptor, so
 * each entry is checked against every budget.
 */
const scanCentralDirectory = (
  view: DataView,
  length: number,
  directory: CentralDirectory,
  opts: ZipBombGuardOptions,
): Match[] => {
  if (
    directory.entryCount === ZIP64_COUNT_SENTINEL ||
    directory.offset === ZIP64_SIZE_SENTINEL
  ) {
    return [UNVERIFIABLE];
  }
  if (directory.entryCount > opts.maxEntries) {
    return [tooManyEntries(opts.maxEntries)];
  }

  let offset = directory.offset;
  let totalUncompressed = 0;

  for (let entry = 0; entry < directory.entryCount; entry++) {
    if (
      offset + CENTRAL_HEADER_BYTES > length ||
      view.getUint32(offset, true) !== CENTRAL_FILE_HEADER
    ) {
      return [UNVERIFIABLE];
    }

    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    if (
      compressedSize === ZIP64_SIZE_SENTINEL ||
      uncompressedSize === ZIP64_SIZE_SENTINEL
    ) {
      return [UNVERIFIABLE];
    }

    if (compressedSize > 0) {
      const ratio = uncompressedSize / compressedSize;
      if (ratio > opts.maxCompressionRatio) {
        return [ratioExceeded(ratio, opts.maxCompressionRatio)];
      }
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > opts.maxTotalUncompressedBytes) {
      return [totalExceeded(opts.maxTotalUncompressedBytes)];
    }

    offset +=
      CENTRAL_HEADER_BYTES +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }

  return [];
};

/**
 * Used only when the archive has no central directory. Sizes then come from
 * local headers, which an entry may legitimately leave empty; such an entry
 * cannot be measured and the walk cannot advance past it either.
 */
const scanLocalHeaders = (
  view: DataView,
  length: number,
  opts: ZipBombGuardOptions,
): Match[] => {
  let offset = 0;
  let entryCount = 0;
  let totalUncompressed = 0;

  while (
    offset + LOCAL_HEADER_BYTES <= length &&
    view.getUint32(offset, true) === LOCAL_FILE_HEADER
  ) {
    entryCount++;
    if (entryCount > opts.maxEntries) {
      return [tooManyEntries(opts.maxEntries)];
    }

    const flags = view.getUint16(offset + 6, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);

    // Bit 3: sizes live in a data descriptor after the file data.
    // eslint-disable-next-line no-bitwise -- ZIP flag check
    if ((flags & 0x00_08) !== 0 && compressedSize === 0) {
      return [UNVERIFIABLE];
    }

    if (compressedSize > 0) {
      const ratio = uncompressedSize / compressedSize;
      if (ratio > opts.maxCompressionRatio) {
        return [ratioExceeded(ratio, opts.maxCompressionRatio)];
      }
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > opts.maxTotalUncompressedBytes) {
      return [totalExceeded(opts.maxTotalUncompressedBytes)];
    }

    offset +=
      LOCAL_HEADER_BYTES +
      view.getUint16(offset + 26, true) +
      view.getUint16(offset + 28, true) +
      compressedSize;
  }

  return [];
};

const scanZipBomb = (bytes: Uint8Array, opts: ZipBombGuardOptions): Match[] => {
  if (bytes.length < 4) {
    return [];
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0, true) !== LOCAL_FILE_HEADER) {
    return [];
  }

  const directory =
    bytes.length >= EOCD_BYTES
      ? findCentralDirectory(view, bytes.length)
      : null;

  return directory
    ? scanCentralDirectory(view, bytes.length, directory, opts)
    : scanLocalHeaders(view, bytes.length, opts);
};
