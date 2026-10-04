/**
 * Builds small Compound File Binary (CFB) containers for tests: a 512-byte
 * sector file with every stream (each under 4 KiB) in the mini stream and
 * storages created from the stream paths. Used by the Outlook .msg tests and
 * the encrypted Office tests.
 */
import { panic } from "better-result";

const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const DIRECTORY_ENTRY_BYTES = 128;
const NO_STREAM = 4_294_967_295;
const END_OF_CHAIN = 4_294_967_294;
const FAT_SECTOR = 4_294_967_293;
const FREE_SECTOR = 4_294_967_295;

export type CompoundFileFixtureStream = {
  path: string[];
  bytes: Uint8Array;
  /** `storage` makes the last path segment an (empty) storage, not a stream. */
  kind?: "storage" | "stream";
};

type DirectoryRecord = {
  name: string;
  type: number;
  leftSiblingId: number;
  rightSiblingId: number;
  childId: number;
  startSector: number;
  streamSize: number;
  bytes?: Uint8Array;
};

export const buildCompoundFile = (
  streams: CompoundFileFixtureStream[],
): Uint8Array => {
  const records = buildDirectoryRecords(streams);
  const miniFat: number[] = [];
  const miniChunks: Uint8Array[] = [];

  for (const record of records) {
    if (record.type !== 2 || !record.bytes) {
      continue;
    }
    const startMiniSector = miniChunks.length;
    const miniSectorCount = Math.max(
      1,
      Math.ceil(record.bytes.byteLength / MINI_SECTOR_SIZE),
    );

    record.startSector = startMiniSector;
    record.streamSize = record.bytes.byteLength;

    for (let index = 0; index < miniSectorCount; index += 1) {
      const chunk = new Uint8Array(MINI_SECTOR_SIZE);
      const start = index * MINI_SECTOR_SIZE;
      chunk.set(record.bytes.subarray(start, start + MINI_SECTOR_SIZE));
      miniChunks.push(chunk);
      miniFat.push(
        index === miniSectorCount - 1
          ? END_OF_CHAIN
          : startMiniSector + index + 1,
      );
    }
  }

  const miniStream = concatAndPad(miniChunks, SECTOR_SIZE);
  const directorySectorCount = Math.ceil(
    (records.length * DIRECTORY_ENTRY_BYTES) / SECTOR_SIZE,
  );
  const miniStreamSectorCount = miniStream.byteLength / SECTOR_SIZE;
  const miniFatBytes = buildUint32Table(miniFat);
  const miniFatSectorCount = miniFatBytes.byteLength / SECTOR_SIZE;

  const directoryStart = 0;
  const miniStreamStart = directorySectorCount;
  const miniFatStart = miniStreamStart + miniStreamSectorCount;
  const fatSector = miniFatStart + miniFatSectorCount;
  const totalSectorCount = fatSector + 1;

  const root = records.at(0);
  if (!root) {
    panic("test fixture must include a root directory record");
  }

  root.startSector = miniStream.byteLength > 0 ? miniStreamStart : END_OF_CHAIN;
  root.streamSize = miniStream.byteLength;

  const directoryBytes = buildDirectoryBytes(records);

  const fat = Array.from({ length: totalSectorCount }, () => FREE_SECTOR);
  linkFatChain(fat, directoryStart, directorySectorCount);
  linkFatChain(fat, miniStreamStart, miniStreamSectorCount);
  linkFatChain(fat, miniFatStart, miniFatSectorCount);
  fat[fatSector] = FAT_SECTOR;

  const fatBytes = buildUint32Table(fat);
  const header = buildHeader({
    directoryStart,
    fatSector,
    miniFatStart,
    miniFatSectorCount,
  });

  const file = new Uint8Array(
    header.byteLength +
      directoryBytes.byteLength +
      miniStream.byteLength +
      miniFatBytes.byteLength +
      fatBytes.byteLength,
  );
  let offset = 0;
  for (const chunk of [
    header,
    directoryBytes,
    miniStream,
    miniFatBytes,
    fatBytes,
  ]) {
    file.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return file;
};

const buildDirectoryRecords = (
  streams: CompoundFileFixtureStream[],
): DirectoryRecord[] => {
  const records: DirectoryRecord[] = [directoryRecord("Root Entry", 5)];
  // Children per storage, keyed by the storage's path ("[]" is the root).
  const rootKey = JSON.stringify([]);
  const childIds = new Map<string, number[]>([[rootKey, []]]);
  const storageIds = new Map<string, number>([[rootKey, 0]]);

  for (const stream of streams) {
    const streamName = stream.path.at(-1);
    if (streamName === undefined) {
      panic("test fixture stream must have a name");
    }
    const isStorage = stream.kind === "storage";
    let parentKey = rootKey;
    for (const [depth, storageName] of (isStorage
      ? stream.path
      : stream.path.slice(0, -1)
    ).entries()) {
      const key = JSON.stringify(stream.path.slice(0, depth + 1));
      if (!storageIds.has(key)) {
        const id = records.length;
        records.push(directoryRecord(storageName, 1));
        storageIds.set(key, id);
        childIds.set(key, []);
        childIds.get(parentKey)?.push(id);
      }
      parentKey = key;
    }
    if (isStorage) {
      continue;
    }
    const id = records.length;
    records.push(streamRecord(streamName, stream.bytes));
    childIds.get(parentKey)?.push(id);
  }

  for (const [key, ids] of childIds) {
    const storageId = storageIds.get(key);
    const storage = storageId === undefined ? undefined : records.at(storageId);
    if (storage) {
      storage.childId = linkSiblings(records, ids);
    }
  }

  return records;
};

const directoryRecord = (name: string, type: number): DirectoryRecord => ({
  name,
  type,
  leftSiblingId: NO_STREAM,
  rightSiblingId: NO_STREAM,
  childId: NO_STREAM,
  startSector: END_OF_CHAIN,
  streamSize: 0,
});

const streamRecord = (name: string, bytes: Uint8Array): DirectoryRecord => ({
  ...directoryRecord(name, 2),
  bytes,
});

const linkSiblings = (records: DirectoryRecord[], ids: number[]): number => {
  if (ids.length === 0) {
    return NO_STREAM;
  }
  for (const [index, id] of ids.entries()) {
    const record = records.at(id);
    if (!record) {
      panic("test fixture sibling id must reference a directory record");
    }
    record.rightSiblingId = ids.at(index + 1) ?? NO_STREAM;
  }
  const firstId = ids.at(0);
  if (firstId === undefined) {
    panic("test fixture sibling list unexpectedly lost its first id");
  }
  return firstId;
};

const buildDirectoryBytes = (records: DirectoryRecord[]): Uint8Array => {
  const bytes = new Uint8Array(
    Math.ceil((records.length * DIRECTORY_ENTRY_BYTES) / SECTOR_SIZE) *
      SECTOR_SIZE,
  );

  for (const [index, record] of records.entries()) {
    const offset = index * DIRECTORY_ENTRY_BYTES;
    writeDirectoryRecord(bytes, offset, record);
  }

  return bytes;
};

const writeDirectoryRecord = (
  bytes: Uint8Array,
  offset: number,
  record: DirectoryRecord,
): void => {
  const view = new DataView(bytes.buffer);
  const nameBytes = Buffer.from(`${record.name}\u0000`, "utf16le");
  bytes.set(nameBytes.subarray(0, 64), offset);
  view.setUint16(offset + 64, Math.min(nameBytes.byteLength, 64), true);
  view.setUint8(offset + 66, record.type);
  view.setUint8(offset + 67, 1);
  view.setUint32(offset + 68, record.leftSiblingId, true);
  view.setUint32(offset + 72, record.rightSiblingId, true);
  view.setUint32(offset + 76, record.childId, true);
  view.setUint32(offset + 116, record.startSector, true);
  view.setUint32(offset + 120, record.streamSize, true);
  view.setUint32(offset + 124, 0, true);
};

const buildHeader = ({
  directoryStart,
  fatSector,
  miniFatStart,
  miniFatSectorCount,
}: {
  directoryStart: number;
  fatSector: number;
  miniFatStart: number;
  miniFatSectorCount: number;
}): Uint8Array => {
  const header = new Uint8Array(SECTOR_SIZE);
  const view = new DataView(header.buffer);
  header.set(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  view.setUint16(24, 0x00_3e, true);
  view.setUint16(26, 0x00_03, true);
  view.setUint16(28, 0xff_fe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, directoryStart, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, miniFatStart, true);
  view.setUint32(64, miniFatSectorCount, true);
  view.setUint32(68, END_OF_CHAIN, true);

  for (let index = 0; index < 109; index += 1) {
    view.setUint32(76 + index * 4, index === 0 ? fatSector : FREE_SECTOR, true);
  }

  return header;
};

const buildUint32Table = (values: number[]): Uint8Array => {
  const bytes = new Uint8Array(
    Math.ceil((values.length * 4) / SECTOR_SIZE) * SECTOR_SIZE,
  );
  const view = new DataView(bytes.buffer);
  for (const [index, value] of values.entries()) {
    view.setUint32(index * 4, value, true);
  }
  for (let offset = values.length * 4; offset < bytes.byteLength; offset += 4) {
    view.setUint32(offset, FREE_SECTOR, true);
  }
  return bytes;
};

const linkFatChain = (
  fat: number[],
  startSector: number,
  sectorCount: number,
): void => {
  if (sectorCount === 0) {
    return;
  }
  for (let index = 0; index < sectorCount; index += 1) {
    fat[startSector + index] =
      index === sectorCount - 1 ? END_OF_CHAIN : startSector + index + 1;
  }
};

const concatAndPad = (chunks: Uint8Array[], blockSize: number): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(Math.ceil(total / blockSize) * blockSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Byte offsets of every directory slot of a small compound file. */
const directorySlots = (bytes: Uint8Array): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 2 ** view.getUint16(30, true);
  const sectorOffset = (sector: number) => (sector + 1) * sectorSize;
  const fat: number[] = [];
  for (let index = 0; index < view.getUint32(44, true); index += 1) {
    const fatSector = view.getUint32(76 + index * 4, true);
    for (let at = 0; at < sectorSize; at += 4) {
      fat.push(view.getUint32(sectorOffset(fatSector) + at, true));
    }
  }
  const slots: number[] = [];
  for (
    let sector = view.getUint32(48, true);
    sector !== END_OF_CHAIN;
    sector = fat[sector] ?? END_OF_CHAIN
  ) {
    for (let at = 0; at < sectorSize; at += DIRECTORY_ENTRY_BYTES) {
      slots.push(sectorOffset(sector) + at);
    }
  }
  return slots;
};

const findEntry = (bytes: Uint8Array, slots: number[], name: string) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameOf = (offset: number) =>
    Buffer.from(
      bytes.subarray(
        offset,
        offset + Math.max(0, view.getUint16(offset + 64, true) - 2),
      ),
    ).toString("utf16le");
  return (
    slots.find(
      (offset) => view.getUint8(offset + 66) !== 0 && nameOf(offset) === name,
    ) ?? panic(`fixture has no entry named ${JSON.stringify(name)}`)
  );
};

type InjectedEntry = {
  /** Name of the storage (or "Root Entry") that receives the new entry. */
  parentName: string;
  name: string;
  kind: "storage" | "stream";
};

/**
 * Adds one empty entry to an existing compound file (a real fixture) by
 * filling a free directory slot and linking it under `parentName`. Assumes
 * the FAT is reachable from the header's DIFAT, as in small files.
 */
export const injectDirectoryEntry = (
  source: Uint8Array,
  { parentName, name, kind }: InjectedEntry,
): Uint8Array => {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer);
  const slots = directorySlots(bytes);
  const parent = findEntry(bytes, slots, parentName);
  const freeIndex = slots.findIndex(
    (offset) => view.getUint8(offset + 66) === 0,
  );
  const free = slots.at(freeIndex);
  if (free === undefined) {
    return panic("fixture has no free directory slot");
  }
  writeDirectoryRecord(bytes, free, {
    ...directoryRecord(name, kind === "storage" ? 1 : 2),
    rightSiblingId: view.getUint32(parent + 76, true),
  });
  view.setUint32(parent + 76, freeIndex, true);
  return bytes;
};

/** Cuts a storage's children out of the tree (they stay allocated). */
export const detachChildren = (
  source: Uint8Array,
  storageName: string,
): Uint8Array => {
  const bytes = source.slice();
  const storage = findEntry(bytes, directorySlots(bytes), storageName);
  new DataView(bytes.buffer).setUint32(storage + 76, NO_STREAM, true);
  return bytes;
};
