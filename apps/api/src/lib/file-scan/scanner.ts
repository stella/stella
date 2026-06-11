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
  scan(bytes: Uint8Array): Promise<Match[]>;
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
    return results.flat();
  };

type ZipBombGuardOptions = {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
};

/** Local file header signature: PK\x03\x04 */
const LOCAL_FILE_HEADER = 0x04_03_4b_50;

export const createZipBombGuard = (opts: ZipBombGuardOptions): Scanner => ({
  scan: async (bytes) => await Promise.resolve(scanZipBomb(bytes, opts)),
});

const scanZipBomb = (bytes: Uint8Array, opts: ZipBombGuardOptions): Match[] => {
  if (bytes.length < 4) {
    return [];
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0, true) !== LOCAL_FILE_HEADER) {
    return [];
  }

  let offset = 0;
  let entryCount = 0;
  let totalUncompressed = 0;

  while (
    offset + 30 <= bytes.length &&
    view.getUint32(offset, true) === LOCAL_FILE_HEADER
  ) {
    entryCount++;

    if (entryCount > opts.maxEntries) {
      return [
        {
          rule: "zip-bomb-entries",
          severity: "critical" as const,
          meta: {
            description: `ZIP contains more than ${opts.maxEntries} entries`,
          },
        },
      ];
    }

    const flags = view.getUint16(offset + 6, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const fileNameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    // Bit 3: sizes are in a data descriptor after the file data, not in the
    // header. We cannot reliably advance past the entry, so flag it rather
    // than silently skipping.
    // eslint-disable-next-line no-bitwise -- ZIP flag check
    if ((flags & 0x00_08) !== 0 && compressedSize === 0) {
      return [
        {
          rule: "zip-data-descriptor",
          severity: "suspicious" as const,
          meta: {
            description:
              "ZIP entry uses a data descriptor; header sizes are zero. " +
              "Cannot verify compression ratio or total size.",
          },
        },
      ];
    }

    totalUncompressed += uncompressedSize;

    if (
      compressedSize > 0 &&
      uncompressedSize / compressedSize > opts.maxCompressionRatio
    ) {
      return [
        {
          rule: "zip-bomb-ratio",
          severity: "critical" as const,
          meta: {
            description: `Entry has compression ratio ${(uncompressedSize / compressedSize).toFixed(0)}:1 (limit: ${opts.maxCompressionRatio}:1)`,
          },
        },
      ];
    }

    if (totalUncompressed > opts.maxTotalUncompressedBytes) {
      return [
        {
          rule: "zip-bomb-size",
          severity: "critical" as const,
          meta: {
            description: `Total uncompressed size exceeds limit of ${opts.maxTotalUncompressedBytes} bytes`,
          },
        },
      ];
    }

    // Skip past header (30 bytes) + filename + extra + compressed data
    offset += 30 + fileNameLen + extraLen + compressedSize;
  }

  return [];
};
