import { deflateRawSync } from "node:zlib";

/**
 * One entry of a hand-built ZIP archive. Everything a real archiver may
 * write is settable, so a test can build the entries a reader must refuse
 * as well as ordinary ones: a name in any bytes, a method the reader does
 * not read, the encryption flag, a Unix link, a stated size that is wrong.
 */
export type RawZipEntry = {
  /** A string is written as UTF-8 with the UTF-8 flag when it needs it. */
  readonly name: string | Uint8Array;
  readonly data?: string | Uint8Array;
  /** 0 stores the data, 8 deflates it; any other method stores it as is. */
  readonly method?: number;
  readonly flags?: number;
  readonly externalAttributes?: number;
  /** The uncompressed size the headers state, when not the data's own. */
  readonly statedSize?: number;
  /** The CRC-32 the headers state, when not the data's own. */
  readonly statedCrc32?: number;
  readonly extra?: Uint8Array;
};

const UTF8_FLAG = 0x08_00;
const MS_DOS_DATE_1980_01_01 = 0x00_21;

/** A Unix file mode, placed where a ZIP's external attributes hold it. */
export const unixExternalAttributes = (mode: number): number =>
  mode * 0x1_00_00;

const UNIX_REGULAR_FILE = 0o10_0644;
export const UNIX_SYMLINK = 0o12_0777;
export const UNIX_DIRECTORY = 0o04_0755;

const asBytes = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

/** The Info-ZIP Unicode path field stating `name` for the stored `stored`. */
export const unicodePathExtra = (
  stored: Uint8Array,
  name: string,
): Uint8Array => {
  const utf8 = new TextEncoder().encode(name);
  const field = new Uint8Array(4 + 5 + utf8.byteLength);
  const view = new DataView(field.buffer);
  view.setUint16(0, 0x70_75, true);
  view.setUint16(2, 5 + utf8.byteLength, true);
  view.setUint8(4, 1);
  view.setUint32(5, Bun.hash.crc32(stored), true);
  field.set(utf8, 9);
  return field;
};

/** A ZIP archive holding `entries` in order, laid out as archivers write it. */
export const makeZipArchive = (entries: readonly RawZipEntry[]): Uint8Array => {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = asBytes(entry.name);
    const data = asBytes(entry.data ?? "");
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const nonAscii =
      typeof entry.name === "string" && name.some((byte) => byte > 0x7f);
    const flags = entry.flags ?? (nonAscii ? UTF8_FLAG : 0);
    const crc32 = entry.statedCrc32 ?? Bun.hash.crc32(data);
    const size = entry.statedSize ?? data.byteLength;
    const extra = entry.extra ?? new Uint8Array();
    const externalAttributes =
      entry.externalAttributes ?? unixExternalAttributes(UNIX_REGULAR_FILE);

    const local = new Uint8Array(30 + name.byteLength + extra.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04_03_4b_50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(12, MS_DOS_DATE_1980_01_01, true);
    lv.setUint32(14, crc32, true);
    lv.setUint32(18, stored.byteLength, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, extra.byteLength, true);
    local.set(name, 30);
    local.set(extra, 30 + name.byteLength);

    const central = new Uint8Array(46 + name.byteLength + extra.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02_01_4b_50, true);
    // Made by Unix (3), version 2.0, so the external attributes are a mode.
    cv.setUint16(4, 0x03_14, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(14, MS_DOS_DATE_1980_01_01, true);
    cv.setUint32(16, crc32, true);
    cv.setUint32(20, stored.byteLength, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint16(30, extra.byteLength, true);
    cv.setUint32(38, externalAttributes, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    central.set(extra, 46 + name.byteLength);

    locals.push(local, stored);
    centrals.push(central);
    offset += local.byteLength + stored.byteLength;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06_05_4b_50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
};
