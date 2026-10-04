/** PK\x03\x04 — local file header signature. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

export const ZIP_BASED_MIMES: readonly string[] = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.template.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.ms-excel.template.macroEnabled.12",
  "application/vnd.ms-excel.addin.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.presentationml.template",
  "application/vnd.ms-powerpoint.template.macroEnabled.12",
  "application/vnd.ms-powerpoint.addin.macroEnabled.12",
  "application/zip",
  "application/x-zip-compressed",
];

export const hasZipMagic = (buffer: Uint8Array): boolean => {
  if (buffer.length < ZIP_MAGIC.length) {
    return false;
  }
  for (let i = 0; i < ZIP_MAGIC.length; i++) {
    if (buffer[i] !== ZIP_MAGIC[i]) {
      return false;
    }
  }
  return true;
};

/** Central directory file header signature: PK\x01\x02 */
const CENTRAL_FILE_HEADER = 0x02_01_4b_50;
/** End of central directory record signature: PK\x05\x06 */
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;
/** Local file header signature: PK\x03\x04 */
const LOCAL_FILE_HEADER = 0x04_03_4b_50;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const EOCD_BYTES = 22;
const MAX_ZIP_COMMENT_BYTES = 0xff_ff;

/** One archive entry as its index describes it, with its stored data. */
export type ZipEntry = {
  name: Buffer;
  /** General-purpose bit flags. */
  flags: number;
  /** Compression method: 0 is stored, 8 is deflate. */
  method: number;
  uncompressedSize: number;
  /** The entry's stored (possibly compressed) bytes. */
  data: Uint8Array;
};

type ZipIndex = { type: "read"; entries: ZipEntry[] } | { type: "malformed" };

const findEndOfCentralDirectory = (view: DataView): number => {
  const length = view.byteLength;
  const earliest = Math.max(0, length - EOCD_BYTES - MAX_ZIP_COMMENT_BYTES);
  for (let at = length - EOCD_BYTES; at >= earliest; at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_DIRECTORY) {
      return at;
    }
  }
  return -1;
};

/**
 * Reads every entry from the central directory and locates its data through
 * the local header. Callers run the archive-index guard first, so ZIP64
 * archives never reach this reader; anything it cannot place is malformed.
 */
export const readZipIndex = (bytes: Uint8Array): ZipIndex => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = bytes.byteLength;
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) {
    return { type: "malformed" };
  }

  const entryCount = view.getUint16(eocd + 10, true);
  const entries: ZipEntry[] = [];
  const centralStart = view.getUint32(eocd + 16, true);
  const spans: { start: number; end: number }[] = [];
  let offset = centralStart;
  for (let index = 0; index < entryCount; index++) {
    if (
      offset + CENTRAL_HEADER_BYTES > length ||
      view.getUint32(offset, true) !== CENTRAL_FILE_HEADER
    ) {
      return { type: "malformed" };
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + CENTRAL_HEADER_BYTES;
    if (
      nameStart + nameLength > length ||
      localOffset + LOCAL_HEADER_BYTES > length ||
      view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER
    ) {
      return { type: "malformed" };
    }
    const dataStart =
      localOffset +
      LOCAL_HEADER_BYTES +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    if (dataStart + compressedSize > length) {
      return { type: "malformed" };
    }
    const flags = view.getUint16(offset + 8, true);
    let end = dataStart + compressedSize;
    if (Math.floor(flags / 8) % 2 === 1) {
      if (end + 12 > centralStart) {
        return { type: "malformed" };
      }
      const descriptor =
        view.getUint32(end, true) === 0x08_07_4b_50 ? end + 4 : end;
      if (
        descriptor + 12 > centralStart ||
        view.getUint32(descriptor + 4, true) !== compressedSize ||
        view.getUint32(descriptor + 8, true) !==
          view.getUint32(offset + 24, true)
      ) {
        return { type: "malformed" };
      }
      end = descriptor + 12;
    }
    spans.push({ start: localOffset, end });
    entries.push({
      name: Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)),
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      data: bytes.subarray(dataStart, dataStart + compressedSize),
    });
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  let nextLocal = 0;
  for (const span of spans.toSorted((a, b) => a.start - b.start)) {
    if (span.start !== nextLocal || span.end > centralStart) {
      return { type: "malformed" };
    }
    nextLocal = span.end;
  }
  if (
    nextLocal !== centralStart ||
    offset !== eocd ||
    eocd + EOCD_BYTES + view.getUint16(eocd + 20, true) !== length
  ) {
    return { type: "malformed" };
  }
  return { type: "read", entries };
};
