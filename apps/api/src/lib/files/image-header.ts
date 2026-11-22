/**
 * Image dimensions read from the container header, without decoding pixels.
 *
 * Derivative admission needs the pixel count before any decoder allocates a
 * surface: the encoded size says nothing about it, since a small file can
 * declare a canvas of any size. Every reader here touches only header bytes
 * and is bounds-checked, so a truncated or hostile header yields `null`
 * rather than an exception or a wrong answer.
 */

/** EXIF orientation 1-8; 1 is "stored as displayed". */
export type ImageOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * How the pixels are encoded, for the formats whose decoders support only
 * some encodings: enough to choose a decoder before handing it the bytes.
 */
type ImageEncoding =
  | {
      format: "png";
      bitDepth: number;
      colorType: number;
      interlaced: boolean;
    }
  | {
      format: "jpeg";
      /** The start-of-frame marker (0xC0 baseline, 0xC2 progressive, ...). */
      frameMarker: number;
      precision: number;
      components: number;
    }
  | {
      format: "heif";
      /** Whether the primary image's colour is an ICC profile (Display P3 on
       *  most phones) rather than `nclx` code points or nothing. */
      iccProfile: boolean;
    };

export type ImageHeader = {
  /** Stored (pre-orientation) width in pixels. */
  width: number;
  /** Stored (pre-orientation) height in pixels. */
  height: number;
  orientation: ImageOrientation;
  /** Present for PNG, JPEG and HEIF. */
  encoding?: ImageEncoding;
};

/** TIFF directories one file may chain before it counts as unreadable. */
const TIFF_DIRECTORIES_MAX = 256;
/** JPEG segments walked before the frame header counts as missing. */
const JPEG_SEGMENTS_MAX = 4096;

const EXIF_ORIENTATION_TAG = 0x01_12;
/** APP1 length field (2) + `Exif\0\0` (6) + the smallest TIFF header (8). */
const EXIF_SEGMENT_MIN_LENGTH = 16;
const TIFF_IMAGE_WIDTH_TAG = 0x01_00;
const TIFF_IMAGE_HEIGHT_TAG = 0x01_01;
const TIFF_SHORT = 3;
const TIFF_LONG = 4;

const isOrientation = (value: number): value is ImageOrientation =>
  Number.isInteger(value) && value >= 1 && value <= 8;

const header = (
  width: number,
  height: number,
  orientation: ImageOrientation = 1,
  encoding?: ImageEncoding,
): ImageHeader | null => {
  if (width <= 0 || height <= 0) {
    return null;
  }
  return encoding === undefined
    ? { width, height, orientation }
    : { width, height, orientation, encoding };
};

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const startsWith = (bytes: Uint8Array, offset: number, ascii: string) => {
  if (offset + ascii.length > bytes.length) {
    return false;
  }
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[offset + index] !== ascii.codePointAt(index)) {
      return false;
    }
  }
  return true;
};

// ── TIFF directories (TIFF files and JPEG EXIF blocks) ──

type TiffEntry = { tag: number; type: number; value: number };

type TiffDirectory = {
  entries: Map<number, TiffEntry>;
  next: number;
};

/**
 * Read one IFD at `offset` inside `tiff` (which starts at the byte-order
 * mark). Only inline SHORT/LONG values are decoded; that covers every tag
 * read here.
 */
const readTiffDirectory = (
  tiff: DataView,
  offset: number,
  littleEndian: boolean,
): TiffDirectory | null => {
  if (offset < 8 || offset + 2 > tiff.byteLength) {
    return null;
  }
  const count = tiff.getUint16(offset, littleEndian);
  const end = offset + 2 + count * 12;
  if (end + 4 > tiff.byteLength) {
    return null;
  }
  const entries = new Map<number, TiffEntry>();
  for (let index = 0; index < count; index += 1) {
    const entry = offset + 2 + index * 12;
    const tag = tiff.getUint16(entry, littleEndian);
    const type = tiff.getUint16(entry + 2, littleEndian);
    const valueCount = tiff.getUint32(entry + 4, littleEndian);
    if (valueCount !== 1) {
      continue;
    }
    if (type === TIFF_SHORT) {
      entries.set(tag, {
        tag,
        type,
        value: tiff.getUint16(entry + 8, littleEndian),
      });
    } else if (type === TIFF_LONG) {
      entries.set(tag, {
        tag,
        type,
        value: tiff.getUint32(entry + 8, littleEndian),
      });
    }
  }
  return { entries, next: tiff.getUint32(end, littleEndian) };
};

const tiffByteOrder = (tiff: DataView): boolean | null => {
  if (tiff.byteLength < 8) {
    return null;
  }
  const mark = tiff.getUint16(0, false);
  let littleEndian: boolean;
  if (mark === 0x49_49) {
    littleEndian = true;
  } else if (mark === 0x4d_4d) {
    littleEndian = false;
  } else {
    return null;
  }
  return tiff.getUint16(2, littleEndian) === 42 ? littleEndian : null;
};

/** The EXIF orientation of a TIFF structure, defaulting to 1 when absent. */
const readTiffOrientation = (tiff: DataView): ImageOrientation => {
  const littleEndian = tiffByteOrder(tiff);
  if (littleEndian === null) {
    return 1;
  }
  const directory = readTiffDirectory(
    tiff,
    tiff.getUint32(4, littleEndian),
    littleEndian,
  );
  const value = directory?.entries.get(EXIF_ORIENTATION_TAG)?.value ?? 1;
  return isOrientation(value) ? value : 1;
};

/**
 * The largest page of a (possibly multi-page) TIFF. Converters render one
 * page at a time, so the largest page is what one render allocates.
 */
const readTiffHeader = (bytes: Uint8Array): ImageHeader | null => {
  const tiff = view(bytes);
  const littleEndian = tiffByteOrder(tiff);
  if (littleEndian === null) {
    return null;
  }
  let offset = tiff.getUint32(4, littleEndian);
  let largest: ImageHeader | null = null;
  const visited = new Set<number>();
  while (offset !== 0) {
    if (visited.has(offset) || visited.size >= TIFF_DIRECTORIES_MAX) {
      return null;
    }
    visited.add(offset);
    const directory = readTiffDirectory(tiff, offset, littleEndian);
    if (directory === null) {
      return null;
    }
    const width = directory.entries.get(TIFF_IMAGE_WIDTH_TAG)?.value ?? 0;
    const height = directory.entries.get(TIFF_IMAGE_HEIGHT_TAG)?.value ?? 0;
    const page = header(width, height);
    if (page === null) {
      return null;
    }
    if (
      largest === null ||
      page.width * page.height > largest.width * largest.height
    ) {
      largest = page;
    }
    offset = directory.next;
  }
  if (largest === null) {
    return null;
  }
  const orientation = readTiffOrientation(tiff);
  return { ...largest, orientation };
};

// ── Format readers ──────────────────────────────────────

const PNG_IHDR_LENGTH = 13;
/** Signature (8) + chunk length and type (8) + IHDR data (13). */
const PNG_IHDR_END = 29;

/** PNG: IHDR is always the first chunk. */
const readPngHeader = (bytes: Uint8Array): ImageHeader | null => {
  if (
    bytes.length < PNG_IHDR_END ||
    bytes[0] !== 0x89 ||
    !startsWith(bytes, 1, "PNG") ||
    !startsWith(bytes, 12, "IHDR")
  ) {
    return null;
  }
  const data = view(bytes);
  if (data.getUint32(8) !== PNG_IHDR_LENGTH) {
    return null;
  }
  return header(data.getUint32(16), data.getUint32(20), 1, {
    format: "png",
    bitDepth: data.getUint8(24),
    colorType: data.getUint8(25),
    interlaced: data.getUint8(28) !== 0,
  });
};

/** Start-of-frame markers that carry dimensions (excludes DHT, JPG, DAC). */
const isJpegFrameMarker = (marker: number) =>
  marker >= 0xc0 &&
  marker <= 0xcf &&
  marker !== 0xc4 &&
  marker !== 0xc8 &&
  marker !== 0xcc;

/** Markers without a length field: TEM and RST0-7. */
const isStandaloneJpegMarker = (marker: number) =>
  marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/** JPEG: the first frame header, plus the EXIF orientation if it precedes it. */
const readJpegHeader = (bytes: Uint8Array): ImageHeader | null => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  const data = view(bytes);
  let orientation: ImageOrientation = 1;
  let offset = 2;
  for (let segment = 0; segment < JPEG_SEGMENTS_MAX; segment += 1) {
    // Markers may be preceded by any number of 0xFF fill bytes.
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes.at(offset);
    if (marker === undefined || bytes[offset - 1] !== 0xff) {
      return null;
    }
    offset += 1;
    if (isStandaloneJpegMarker(marker)) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      // End of image or start of scan before any frame header.
      return null;
    }
    if (offset + 2 > bytes.length) {
      return null;
    }
    const length = data.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) {
      return null;
    }
    if (isJpegFrameMarker(marker)) {
      // Length (2), precision (1), height (2), width (2), components (1).
      if (length < 8) {
        return null;
      }
      return header(
        data.getUint16(offset + 5),
        data.getUint16(offset + 3),
        orientation,
        {
          format: "jpeg",
          frameMarker: marker,
          precision: data.getUint8(offset + 2),
          components: data.getUint8(offset + 7),
        },
      );
    }
    // `length` counts its own two bytes; the segment ends at offset + length,
    // already checked to lie inside the buffer.
    if (
      marker === 0xe1 &&
      length >= EXIF_SEGMENT_MIN_LENGTH &&
      startsWith(bytes, offset + 2, "Exif\0\0")
    ) {
      orientation = readTiffOrientation(
        new DataView(bytes.buffer, bytes.byteOffset + offset + 8, length - 8),
      );
    }
    offset += length;
  }
  return null;
};

/** GIF: the logical screen bounds every frame. */
const readGifHeader = (bytes: Uint8Array): ImageHeader | null => {
  if (
    bytes.length < 10 ||
    !(startsWith(bytes, 0, "GIF87a") || startsWith(bytes, 0, "GIF89a"))
  ) {
    return null;
  }
  const data = view(bytes);
  return header(data.getUint16(6, true), data.getUint16(8, true));
};

/** BMP: BITMAPCOREHEADER (16-bit) or any later info header (signed 32-bit). */
const readBmpHeader = (bytes: Uint8Array): ImageHeader | null => {
  if (bytes.length < 26 || !startsWith(bytes, 0, "BM")) {
    return null;
  }
  const data = view(bytes);
  const infoSize = data.getUint32(14, true);
  if (14 + infoSize > bytes.length) {
    return null;
  }
  if (infoSize === 12) {
    return header(data.getUint16(18, true), data.getUint16(20, true));
  }
  if (infoSize < 40) {
    return null;
  }
  // A negative height marks a top-down bitmap; the magnitude is the height.
  return header(
    Math.abs(data.getInt32(18, true)),
    Math.abs(data.getInt32(22, true)),
  );
};

/** Little-endian unsigned integer of `length` bytes (at most 3) at `offset`. */
const uintLe = (bytes: Uint8Array, offset: number, length: number) => {
  let value = 0;
  for (let index = length - 1; index >= 0; index -= 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  return value;
};

/** WebP: lossy (VP8), lossless (VP8L) or extended (VP8X canvas). */
const readWebpHeader = (bytes: Uint8Array): ImageHeader | null => {
  if (
    bytes.length < 30 ||
    !startsWith(bytes, 0, "RIFF") ||
    !startsWith(bytes, 8, "WEBP")
  ) {
    return null;
  }
  const chunkSize = uintLe(bytes, 16, 3) + (bytes[19] ?? 0) * 0x1_00_00_00;
  const chunkFits = (minimum: number) =>
    chunkSize >= minimum && 20 + chunkSize <= bytes.length;
  if (startsWith(bytes, 12, "VP8 ")) {
    if (!chunkFits(10)) {
      return null;
    }
    // 14-bit dimensions; the top two bits of each are a scaling hint.
    return header(
      uintLe(bytes, 26, 2) % 0x40_00,
      uintLe(bytes, 28, 2) % 0x40_00,
    );
  }
  if (startsWith(bytes, 12, "VP8L")) {
    if (!chunkFits(5) || bytes[20] !== 0x2f) {
      return null;
    }
    // Width-1 and height-1 as consecutive 14-bit fields after the signature.
    const bits = uintLe(bytes, 21, 3) + (bytes[24] ?? 0) * 0x1_00_00_00;
    return header(
      (bits % 0x40_00) + 1,
      (Math.floor(bits / 0x40_00) % 0x40_00) + 1,
    );
  }
  if (startsWith(bytes, 12, "VP8X")) {
    if (!chunkFits(10)) {
      return null;
    }
    return header(uintLe(bytes, 24, 3) + 1, uintLe(bytes, 27, 3) + 1);
  }
  return null;
};

// ── HEIF (HEIC photos) ──

/** Boxes one level of a HEIF file may hold before it counts as unreadable. */
const HEIF_BOXES_MAX = 4096;
/** Item property associations read before the file counts as unreadable. */
const HEIF_ASSOCIATIONS_MAX = 65_536;

type HeifBox = { type: string; start: number; end: number };

/** The boxes between `start` and `end`, or `null` if one overruns them. */
const heifBoxes = (
  bytes: Uint8Array,
  start: number,
  end: number,
): HeifBox[] | null => {
  const data = view(bytes);
  const boxes: HeifBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    if (boxes.length >= HEIF_BOXES_MAX) {
      return null;
    }
    let size = data.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end || data.getUint32(offset + 8) !== 0) {
        return null;
      }
      size = data.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      return null;
    }
    boxes.push({
      type: String.fromCodePoint(...bytes.subarray(offset + 4, offset + 8)),
      start: offset + headerSize,
      end: offset + size,
    });
    offset += size;
  }
  return boxes;
};

/** A 2x2 integer matrix, row-major, acting on (x right, y down). */
type Turn = readonly [number, number, number, number];

const TURN_BY_ORIENTATION = {
  1: [1, 0, 0, 1],
  2: [-1, 0, 0, 1],
  3: [-1, 0, 0, -1],
  4: [1, 0, 0, -1],
  5: [0, 1, 1, 0],
  6: [0, -1, 1, 0],
  7: [0, -1, -1, 0],
  8: [0, 1, -1, 0],
} as const satisfies Record<ImageOrientation, Turn>;

/** `after` applied to the result of `before`. */
const compose = (after: Turn, before: Turn): Turn => [
  after[0] * before[0] + after[1] * before[2],
  after[0] * before[1] + after[1] * before[3],
  after[2] * before[0] + after[3] * before[2],
  after[2] * before[1] + after[3] * before[3],
];

const orientationOfTurn = (turn: Turn): ImageOrientation => {
  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
    if (TURN_BY_ORIENTATION[orientation].every((v, i) => v === turn[i])) {
      return orientation;
    }
  }
  return 1;
};

/**
 * `irot` turns anticlockwise in quarter turns; `imir` mirrors top to bottom
 * (axis 0) or left to right (axis 1). Transformative properties apply in the
 * order the item lists them.
 */
const heifTurn = (property: HeifBox, bytes: Uint8Array): Turn | null => {
  const value = bytes[property.start];
  if (value === undefined || property.end <= property.start) {
    return null;
  }
  if (property.type === "irot") {
    const quarterTurns = [1, 8, 3, 6] as const;
    return TURN_BY_ORIENTATION[quarterTurns[value % 4] ?? 1];
  }
  if (property.type === "imir") {
    return TURN_BY_ORIENTATION[value % 2 === 0 ? 4 : 2];
  }
  return null;
};

/**
 * An image sequence without a still primary image: the size of its first
 * video track's pictures, from `moov/trak/tkhd` (16.16 fixed point).
 */
const readHeifSequenceHeader = (
  bytes: Uint8Array,
  top: readonly HeifBox[],
): ImageHeader | null => {
  const moov = top.find((box) => box.type === "moov");
  if (moov === undefined) {
    return null;
  }
  const data = view(bytes);
  for (const trak of heifBoxes(bytes, moov.start, moov.end) ?? []) {
    if (trak.type !== "trak") {
      continue;
    }
    const tkhd = heifBoxes(bytes, trak.start, trak.end)?.find(
      (box) => box.type === "tkhd",
    );
    if (tkhd === undefined) {
      return null;
    }
    // Version 1 widens creation, modification time and duration to 64 bits.
    const sizeOffset = tkhd.start + (bytes[tkhd.start] === 1 ? 88 : 76);
    if (sizeOffset + 8 > tkhd.end) {
      return null;
    }
    const width = Math.floor(data.getUint32(sizeOffset) / 0x1_00_00);
    const height = Math.floor(data.getUint32(sizeOffset + 4) / 0x1_00_00);
    if (width > 0 && height > 0) {
      return header(width, height, 1, { format: "heif", iccProfile: false });
    }
  }
  return null;
};

/** The primary item's id from `pitm` (16-bit in version 0, else 32-bit). */
const heifPrimaryItem = (bytes: Uint8Array, pitm: HeifBox): number | null => {
  if (pitm.start + 6 > pitm.end) {
    return null;
  }
  const data = view(bytes);
  if (bytes[pitm.start] === 0) {
    return data.getUint16(pitm.start + 4);
  }
  return pitm.start + 8 > pitm.end ? null : data.getUint32(pitm.start + 4);
};

/**
 * The properties `item` is associated with in one `ipma` box, in order, or
 * `null` when the box overruns itself. `budget` counts associations read so
 * far across boxes, so a file cannot make this loop for long.
 */
const heifAssociations = (
  bytes: Uint8Array,
  ipma: HeifBox,
  {
    budget,
    item,
    properties,
  }: {
    budget: { read: number };
    item: number;
    properties: readonly HeifBox[];
  },
): HeifBox[] | null => {
  if (ipma.start + 8 > ipma.end) {
    return null;
  }
  const data = view(bytes);
  const idSize = (bytes[ipma.start] ?? 0) < 1 ? 2 : 4;
  // Flag bit 0 widens each property index to 16 bits.
  const indexSize = (bytes[ipma.start + 3] ?? 0) % 2 === 1 ? 2 : 1;
  const entries = data.getUint32(ipma.start + 4);
  const associated: HeifBox[] = [];
  let offset = ipma.start + 8;
  for (let entry = 0; entry < entries; entry += 1) {
    if (offset + idSize + 1 > ipma.end) {
      return null;
    }
    const entryItem =
      idSize === 2 ? data.getUint16(offset) : data.getUint32(offset);
    const count = bytes[offset + idSize] ?? 0;
    offset += idSize + 1;
    budget.read += count;
    if (
      offset + count * indexSize > ipma.end ||
      budget.read > HEIF_ASSOCIATIONS_MAX
    ) {
      return null;
    }
    for (let association = 0; association < count; association += 1) {
      // The top bit marks an essential property; the rest is its 1-based index.
      const index =
        indexSize === 2
          ? data.getUint16(offset) % 0x80_00
          : (bytes[offset] ?? 0) % 0x80;
      offset += indexSize;
      const property = properties[index - 1];
      if (entryItem === item && property !== undefined) {
        associated.push(property);
      }
    }
  }
  return associated;
};

/** The properties of the primary item listed in a `meta` box, in order. */
const heifPrimaryProperties = (
  bytes: Uint8Array,
  meta: HeifBox,
): HeifBox[] | null => {
  // `meta` is a full box: version and flags precede its children.
  const children = heifBoxes(bytes, meta.start + 4, meta.end);
  const pitm = children?.find((box) => box.type === "pitm");
  const iprp = children?.find((box) => box.type === "iprp");
  const primary = pitm === undefined ? null : heifPrimaryItem(bytes, pitm);
  if (primary === null || iprp === undefined) {
    return null;
  }
  const iprpChildren = heifBoxes(bytes, iprp.start, iprp.end) ?? [];
  const ipco = iprpChildren.find((box) => box.type === "ipco");
  const properties =
    ipco === undefined ? null : heifBoxes(bytes, ipco.start, ipco.end);
  if (properties === null) {
    return null;
  }
  const budget = { read: 0 };
  const associated: HeifBox[] = [];
  for (const ipma of iprpChildren.filter((box) => box.type === "ipma")) {
    const own = heifAssociations(bytes, ipma, {
      budget,
      item: primary,
      properties,
    });
    if (own === null) {
      return null;
    }
    associated.push(...own);
  }
  return associated;
};

/**
 * HEIF (HEIC photos): the primary item's `ispe` size, the orientation its
 * `irot` and `imir` properties make, and whether its colour is an ICC
 * profile. Reads only the `ftyp` and `meta` boxes; the image data is never
 * touched, so the answer is the same whether previews decode or not.
 */
const readHeifHeader = (bytes: Uint8Array): ImageHeader | null => {
  if (bytes.length < 16 || !startsWith(bytes, 4, "ftyp")) {
    return null;
  }
  const top = heifBoxes(bytes, 0, bytes.length);
  if (top === null) {
    return null;
  }
  const meta = top.find((box) => box.type === "meta");
  if (meta === undefined) {
    return readHeifSequenceHeader(bytes, top);
  }
  const associated = heifPrimaryProperties(bytes, meta);
  const ispe = associated?.find((box) => box.type === "ispe");
  if (associated === null || ispe === undefined || ispe.start + 12 > ispe.end) {
    return null;
  }
  let turn: Turn = TURN_BY_ORIENTATION[1];
  for (const property of associated) {
    const next = heifTurn(property, bytes);
    if (next !== null) {
      turn = compose(next, turn);
    }
  }
  const colour = associated.find((box) => box.type === "colr");
  const colourType =
    colour === undefined || colour.start + 4 > colour.end
      ? null
      : String.fromCodePoint(...bytes.subarray(colour.start, colour.start + 4));
  const data = view(bytes);
  // ispe is a full box: version and flags, then width and height.
  return header(
    data.getUint32(ispe.start + 4),
    data.getUint32(ispe.start + 8),
    orientationOfTurn(turn),
    {
      format: "heif",
      iccProfile: colourType === "prof" || colourType === "rICC",
    },
  );
};

const IMAGE_HEADER_READERS = {
  "image/bmp": readBmpHeader,
  "image/gif": readGifHeader,
  "image/heic": readHeifHeader,
  "image/heic-sequence": readHeifHeader,
  "image/heif": readHeifHeader,
  "image/heif-sequence": readHeifHeader,
  "image/jpeg": readJpegHeader,
  "image/png": readPngHeader,
  "image/tiff": readTiffHeader,
  "image/webp": readWebpHeader,
} as const satisfies Record<string, (bytes: Uint8Array) => ImageHeader | null>;

export type HeaderReadableImageMimeType = keyof typeof IMAGE_HEADER_READERS;

export const isHeaderReadableImageMimeType = (
  mimeType: string,
): mimeType is HeaderReadableImageMimeType =>
  Object.hasOwn(IMAGE_HEADER_READERS, mimeType);

/**
 * Dimensions and orientation from the header of an image of a supported
 * type, or `null` when the header is missing, truncated or malformed.
 */
export const readImageHeader = (
  bytes: Uint8Array,
  mimeType: HeaderReadableImageMimeType,
): ImageHeader | null => IMAGE_HEADER_READERS[mimeType](bytes);
