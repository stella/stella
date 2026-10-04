/**
 * A bounded reader for Compound File Binary containers (CFB, also called
 * OLE2): Outlook .msg files, legacy binary Office files, and password
 * protected OOXML documents.
 *
 * The reader only follows what the header and the allocation tables say, and
 * every step is bounded by the file itself or by a fixed limit:
 *
 * - every sector read is checked against the file length;
 * - a sector chain (FAT, mini FAT, DIFAT) never revisits a sector and stops at
 *   `MAX_CHAIN_SECTORS`;
 * - the FAT may not claim more sectors than the file can hold;
 * - the directory stops at `MAX_DIRECTORY_ENTRIES` before it is read whole;
 * - the directory tree is walked with an explicit stack, never recursion, and
 *   storages nest at most `MAX_STORAGE_DEPTH` deep.
 *
 * A parse failure says whether the bytes were malformed or a limit stopped the
 * reader (`limitReached`): a container past a limit may still be valid, so a
 * caller that decides something from the parse can tell "not this" from "did
 * not finish".
 */
import { TaggedError } from "better-result";

const CFB_SIGNATURE = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

const HEADER_BYTES = 512;
const NO_STREAM = 4_294_967_295;
const END_OF_CHAIN = 4_294_967_294;
const FAT_SECTOR = 4_294_967_293;
const MAX_CHAIN_SECTORS = 65_536;
const MAX_DIRECTORY_ENTRIES = 16_384;
const MAX_STORAGE_DEPTH = 32;
const DIRECTORY_ENTRY_BYTES = 128;
const HEADER_DIFAT_ENTRIES = 109;
const MINI_STREAM_CUTOFF_DEFAULT = 4096;
const UINT32_RANGE = 4_294_967_296n;
const SUPPORTED_SECTOR_SHIFTS = new Set([9, 12]);
const SUPPORTED_MINI_SECTOR_SHIFT = 6;

export const CFB_OBJECT_TYPE = {
  storage: 1,
  stream: 2,
  root: 5,
} as const;

export class CompoundFileParseError extends TaggedError(
  "CompoundFileParseError",
)<{
  message: string;
  /** A reader limit stopped the parse; the container may still be valid. */
  limitReached: boolean;
}> {}

export type CompoundFileEntry = {
  id: number;
  name: string;
  type: number;
  leftSiblingId: number;
  rightSiblingId: number;
  childId: number;
  startSector: number;
  streamSize: number;
};

export type CompoundFileStream = {
  entry: CompoundFileEntry;
  /** Storage names from the root down, ending with the stream's own name. */
  path: string[];
};

const malformed = (message: string): CompoundFileParseError =>
  new CompoundFileParseError({ message, limitReached: false });

const limit = (message: string): CompoundFileParseError =>
  new CompoundFileParseError({ message, limitReached: true });

/** Whether the bytes start with the CFB signature. */
export const hasCompoundFileSignature = (bytes: Uint8Array): boolean => {
  if (bytes.byteLength < CFB_SIGNATURE.byteLength) {
    return false;
  }
  return CFB_SIGNATURE.every((byte, index) => bytes[index] === byte);
};

export class CompoundFile {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniStreamCutoff: number;
  /** Whole sectors after the header. */
  private readonly fileSectorCount: number;
  private readonly fat: number[];
  private readonly directoryEntries: CompoundFileEntry[];
  private readonly rootEntry: CompoundFileEntry;
  private miniParts: { miniStream: Uint8Array; miniFat: number[] } | null =
    null;
  readonly streamEntries: CompoundFileStream[];

  /** @throws {CompoundFileParseError} when the bytes are malformed or a limit is reached */
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < HEADER_BYTES) {
      throw malformed("Compound file is too small to contain a CFB header");
    }
    if (!hasCompoundFileSignature(bytes)) {
      throw malformed("Compound file has an invalid CFB signature");
    }

    const sectorShift = this.readUint16(30);
    const miniSectorShift = this.readUint16(32);
    if (
      !SUPPORTED_SECTOR_SHIFTS.has(sectorShift) ||
      miniSectorShift !== SUPPORTED_MINI_SECTOR_SHIFT
    ) {
      throw malformed("Compound file uses an unsupported CFB sector size");
    }

    this.sectorSize = 2 ** sectorShift;
    this.miniSectorSize = 2 ** miniSectorShift;
    this.miniStreamCutoff = this.readUint32(56) || MINI_STREAM_CUTOFF_DEFAULT;
    this.fileSectorCount = Math.max(
      0,
      Math.floor(bytes.byteLength / this.sectorSize) - 1,
    );

    this.fat = this.readFat(this.readDifatSectorIds());
    this.directoryEntries = this.readDirectoryEntries();

    const rootEntry = this.directoryEntries.at(0);
    if (rootEntry?.type !== CFB_OBJECT_TYPE.root) {
      throw malformed("Compound file is missing the root storage");
    }
    this.rootEntry = rootEntry;
    this.streamEntries = this.collectStreamEntries();
  }

  /** @throws {CompoundFileParseError} when the bytes are malformed or a limit is reached */
  readStream(entry: CompoundFileEntry): Uint8Array {
    if (entry.streamSize >= this.miniStreamCutoff) {
      return this.readRegularStream(entry);
    }
    return this.readMiniStream(entry);
  }

  private readDifatSectorIds(): number[] {
    const fatSectorCount = this.readUint32(44);
    // One FAT sector maps `sectorSize / 4` sectors; a FAT that needs more
    // sectors than the file holds cannot describe this file.
    const maxFatSectors =
      Math.ceil(this.fileSectorCount / (this.sectorSize / 4)) + 1;
    if (fatSectorCount > maxFatSectors) {
      throw malformed("Compound file FAT is larger than the file");
    }

    const difat: number[] = [];
    for (let index = 0; index < HEADER_DIFAT_ENTRIES; index += 1) {
      const sectorId = this.readUint32(76 + index * 4);
      if (sectorId !== NO_STREAM) {
        difat.push(sectorId);
      }
    }

    let nextDifatSector = this.readUint32(68);
    let remainingDifatSectors = this.readUint32(72);
    const entriesPerDifatSector = this.sectorSize / 4 - 1;
    const seen = new Set<number>();

    while (
      nextDifatSector !== END_OF_CHAIN &&
      nextDifatSector !== NO_STREAM &&
      remainingDifatSectors > 0 &&
      difat.length < fatSectorCount
    ) {
      if (seen.has(nextDifatSector)) {
        throw malformed("Compound file DIFAT chain revisits a sector");
      }
      seen.add(nextDifatSector);
      const sector = this.readSector(nextDifatSector);
      const view = dataViewFor(sector);
      for (
        let index = 0;
        index < entriesPerDifatSector && difat.length < fatSectorCount;
        index += 1
      ) {
        const sectorId = view.getUint32(index * 4, true);
        if (sectorId !== NO_STREAM) {
          difat.push(sectorId);
        }
      }
      nextDifatSector = view.getUint32(entriesPerDifatSector * 4, true);
      remainingDifatSectors -= 1;
    }

    return difat.slice(0, fatSectorCount);
  }

  private readFat(fatSectorIds: number[]): number[] {
    const fat: number[] = [];
    for (const sectorId of fatSectorIds) {
      const sector = this.readSector(sectorId);
      const view = dataViewFor(sector);
      for (let offset = 0; offset < sector.byteLength; offset += 4) {
        fat.push(view.getUint32(offset, true));
      }
    }
    return fat;
  }

  private miniStreamParts(): { miniStream: Uint8Array; miniFat: number[] } {
    if (this.miniParts) {
      return this.miniParts;
    }
    const miniStream = this.readRegularStream(this.rootEntry);
    const firstMiniFatSector = this.readUint32(60);
    const miniFat: number[] = [];
    if (
      firstMiniFatSector !== END_OF_CHAIN &&
      firstMiniFatSector !== NO_STREAM
    ) {
      const bytes = this.readSectorChain(firstMiniFatSector);
      const view = dataViewFor(bytes);
      for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 4) {
        miniFat.push(view.getUint32(offset, true));
      }
    }
    this.miniParts = { miniStream, miniFat };
    return this.miniParts;
  }

  private readDirectoryEntries(): CompoundFileEntry[] {
    const maxDirectorySectors = Math.ceil(
      (MAX_DIRECTORY_ENTRIES * DIRECTORY_ENTRY_BYTES) / this.sectorSize,
    );
    const directoryBytes = this.readSectorChain(
      this.readUint32(48),
      maxDirectorySectors,
      "Compound file directory exceeds the entry limit",
    );
    const entries: CompoundFileEntry[] = [];

    for (
      let offset = 0;
      offset + DIRECTORY_ENTRY_BYTES <= directoryBytes.byteLength;
      offset += DIRECTORY_ENTRY_BYTES
    ) {
      const view = new DataView(
        directoryBytes.buffer,
        directoryBytes.byteOffset + offset,
        DIRECTORY_ENTRY_BYTES,
      );
      const nameByteLength = view.getUint16(64, true);
      const safeNameByteLength = Math.min(nameByteLength, 64);
      const name =
        safeNameByteLength > 2
          ? decodeUtf16(
              directoryBytes.subarray(offset, offset + safeNameByteLength - 2),
            )
          : "";

      entries.push({
        id: entries.length,
        name,
        type: view.getUint8(66),
        leftSiblingId: view.getUint32(68, true),
        rightSiblingId: view.getUint32(72, true),
        childId: view.getUint32(76, true),
        startSector: view.getUint32(116, true),
        streamSize: readDirectoryStreamSize(view),
      });
    }

    return entries;
  }

  /**
   * Walks the directory's sibling trees in order (left, self, children,
   * right) with an explicit stack. An entry is visited once, so a tree that
   * links back to itself ends instead of looping.
   */
  private collectStreamEntries(): CompoundFileStream[] {
    type Task =
      | { kind: "visit"; id: number; path: string[] }
      | { kind: "emit"; entry: CompoundFileEntry; path: string[] };
    const streamEntries: CompoundFileStream[] = [];
    const visited = new Set<number>();
    const stack: Task[] = [
      { kind: "visit", id: this.rootEntry.childId, path: [] },
    ];

    for (let task = stack.pop(); task; task = stack.pop()) {
      if (task.kind === "emit") {
        streamEntries.push({
          entry: task.entry,
          path: [...task.path, task.entry.name],
        });
        continue;
      }
      if (task.id === NO_STREAM || visited.has(task.id)) {
        continue;
      }
      const entry = this.directoryEntries.at(task.id);
      if (!entry) {
        continue;
      }
      visited.add(task.id);

      stack.push({ kind: "visit", id: entry.rightSiblingId, path: task.path });
      if (entry.type === CFB_OBJECT_TYPE.storage) {
        if (task.path.length >= MAX_STORAGE_DEPTH) {
          throw limit("Compound file storages nest past the depth limit");
        }
        stack.push({
          kind: "visit",
          id: entry.childId,
          path: [...task.path, entry.name],
        });
      }
      if (entry.type === CFB_OBJECT_TYPE.stream) {
        stack.push({ kind: "emit", entry, path: task.path });
      }
      stack.push({ kind: "visit", id: entry.leftSiblingId, path: task.path });
    }

    return streamEntries;
  }

  private readRegularStream(entry: CompoundFileEntry): Uint8Array {
    if (entry.streamSize === 0 || entry.startSector === END_OF_CHAIN) {
      return new Uint8Array();
    }
    return this.readSectorChain(entry.startSector).slice(0, entry.streamSize);
  }

  private readMiniStream(entry: CompoundFileEntry): Uint8Array {
    if (entry.streamSize === 0 || entry.startSector === END_OF_CHAIN) {
      return new Uint8Array();
    }

    const { miniStream, miniFat } = this.miniStreamParts();
    const chunks: Uint8Array[] = [];
    const seen = new Set<number>();
    let sectorId = entry.startSector;

    while (sectorId !== END_OF_CHAIN) {
      if (sectorId === NO_STREAM || seen.has(sectorId)) {
        throw malformed(
          "Compound file mini stream has an invalid sector chain",
        );
      }
      if (seen.size >= MAX_CHAIN_SECTORS) {
        throw limit("Compound file mini stream exceeds the sector chain limit");
      }
      if (sectorId >= miniFat.length) {
        throw malformed(
          "Compound file mini stream references a missing mini FAT entry",
        );
      }
      const offset = sectorId * this.miniSectorSize;
      const end = offset + this.miniSectorSize;
      if (end > miniStream.byteLength) {
        throw malformed(
          "Compound file mini stream references bytes outside the root stream",
        );
      }
      seen.add(sectorId);
      chunks.push(miniStream.subarray(offset, end));
      sectorId = miniFat[sectorId] ?? END_OF_CHAIN;
    }

    return concatChunks(chunks).slice(0, entry.streamSize);
  }

  private readSectorChain(
    firstSector: number,
    maxSectors = MAX_CHAIN_SECTORS,
    limitMessage = "Compound file stream exceeds the sector chain limit",
  ): Uint8Array {
    const chunks: Uint8Array[] = [];
    const seen = new Set<number>();
    let sectorId = firstSector;

    while (sectorId !== END_OF_CHAIN) {
      if (sectorId === NO_STREAM || sectorId === FAT_SECTOR) {
        throw malformed("Compound file stream has an invalid sector chain");
      }
      if (sectorId >= this.fat.length || seen.has(sectorId)) {
        throw malformed(
          "Compound file stream references an invalid FAT sector",
        );
      }
      if (seen.size >= maxSectors) {
        throw limit(limitMessage);
      }
      seen.add(sectorId);
      chunks.push(this.readSector(sectorId));
      sectorId = this.fat[sectorId] ?? END_OF_CHAIN;
    }

    return concatChunks(chunks);
  }

  private readSector(sectorId: number): Uint8Array {
    const offset = (sectorId + 1) * this.sectorSize;
    const end = offset + this.sectorSize;
    if (end > this.bytes.byteLength) {
      throw malformed("Compound file sector points outside the file");
    }
    return this.bytes.subarray(offset, end);
  }

  private readUint16(offset: number): number {
    return this.view.getUint16(offset, true);
  }

  private readUint32(offset: number): number {
    return this.view.getUint32(offset, true);
  }
}

const readDirectoryStreamSize = (view: DataView): number => {
  const low = view.getUint32(120, true);
  const high = view.getUint32(124, true);
  if (high === 0) {
    return low;
  }

  const size = BigInt(high) * UINT32_RANGE + BigInt(low);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw malformed("Compound file stream is too large to parse safely");
  }
  return Number(size);
};

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const decodeUtf16 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("utf16le");

const dataViewFor = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
