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
import { Result, TaggedError } from "better-result";

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

const CFB_OBJECT_TYPE = {
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

/** One storage or stream reachable from the root, with its full path. */
export type CompoundFileTreeEntry = {
  path: string[];
  kind: "storage" | "stream" | "other";
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

type SectorLayout = {
  bytes: Uint8Array;
  view: DataView;
  sectorSize: number;
  /** Whole sectors after the header. */
  fileSectorCount: number;
};

type FatLayout = SectorLayout & { fat: number[] };

type ParseResult<T> = Result<T, CompoundFileParseError>;

type CompoundFileParts = {
  layout: FatLayout;
  miniSectorSize: number;
  miniStreamCutoff: number;
  rootEntry: CompoundFileEntry;
  streamEntries: CompoundFileStream[];
  tree: CompoundFileTreeEntry[];
  unreachableEntryCount: number;
};

export class CompoundFile {
  private readonly layout: FatLayout;
  private readonly miniSectorSize: number;
  private readonly miniStreamCutoff: number;
  private readonly rootEntry: CompoundFileEntry;
  private miniParts: { miniStream: Uint8Array; miniFat: number[] } | null =
    null;
  readonly streamEntries: CompoundFileStream[];
  /** Every entry reachable from the root storage (traversal order). */
  readonly tree: CompoundFileTreeEntry[];
  /**
   * Allocated directory entries (storages and streams) the root's tree does
   * not reach. Readers ignore them; a caller matching an exact layout may not.
   */
  readonly unreachableEntryCount: number;

  private constructor(parts: CompoundFileParts) {
    this.layout = parts.layout;
    this.miniSectorSize = parts.miniSectorSize;
    this.miniStreamCutoff = parts.miniStreamCutoff;
    this.rootEntry = parts.rootEntry;
    this.streamEntries = parts.streamEntries;
    this.tree = parts.tree;
    this.unreachableEntryCount = parts.unreachableEntryCount;
  }

  /** Reads the header, the allocation tables and the directory tree. */
  static parse(bytes: Uint8Array): ParseResult<CompoundFile> {
    return parseParts(bytes).map((parts) => new CompoundFile(parts));
  }

  readStream(entry: CompoundFileEntry): ParseResult<Uint8Array> {
    if (entry.streamSize >= this.miniStreamCutoff) {
      return readRegularStream(this.layout, entry);
    }
    return this.readMiniStream(entry);
  }

  private miniStreamParts(): ParseResult<{
    miniStream: Uint8Array;
    miniFat: number[];
  }> {
    if (this.miniParts) {
      return Result.ok(this.miniParts);
    }
    const parts = readMiniStreamParts(this.layout, this.rootEntry);
    if (Result.isOk(parts)) {
      this.miniParts = parts.value;
    }
    return parts;
  }

  private readMiniStream(entry: CompoundFileEntry): ParseResult<Uint8Array> {
    if (entry.streamSize === 0 || entry.startSector === END_OF_CHAIN) {
      return Result.ok(new Uint8Array());
    }
    const parts = this.miniStreamParts();
    if (Result.isError(parts)) {
      return parts;
    }
    const { miniStream, miniFat } = parts.value;
    const chunks: Uint8Array[] = [];
    const seen = new Set<number>();
    let sectorId = entry.startSector;

    while (sectorId !== END_OF_CHAIN) {
      if (sectorId === NO_STREAM || seen.has(sectorId)) {
        return Result.err(
          malformed("Compound file mini stream has an invalid sector chain"),
        );
      }
      if (seen.size >= MAX_CHAIN_SECTORS) {
        return Result.err(
          limit("Compound file mini stream exceeds the sector chain limit"),
        );
      }
      if (sectorId >= miniFat.length) {
        return Result.err(
          malformed(
            "Compound file mini stream references a missing mini FAT entry",
          ),
        );
      }
      const offset = sectorId * this.miniSectorSize;
      const end = offset + this.miniSectorSize;
      if (end > miniStream.byteLength) {
        return Result.err(
          malformed(
            "Compound file mini stream references bytes outside the root stream",
          ),
        );
      }
      seen.add(sectorId);
      chunks.push(miniStream.subarray(offset, end));
      sectorId = miniFat[sectorId] ?? END_OF_CHAIN;
    }

    return Result.ok(concatChunks(chunks).slice(0, entry.streamSize));
  }
}

const parseParts = (bytes: Uint8Array): ParseResult<CompoundFileParts> =>
  Result.gen(function* () {
    if (bytes.byteLength < HEADER_BYTES) {
      return Result.err(
        malformed("Compound file is too small to contain a CFB header"),
      );
    }
    if (!hasCompoundFileSignature(bytes)) {
      return Result.err(
        malformed("Compound file has an invalid CFB signature"),
      );
    }
    const view = dataViewFor(bytes);
    const sectorShift = view.getUint16(30, true);
    const miniSectorShift = view.getUint16(32, true);
    if (
      !SUPPORTED_SECTOR_SHIFTS.has(sectorShift) ||
      miniSectorShift !== SUPPORTED_MINI_SECTOR_SHIFT
    ) {
      return Result.err(
        malformed("Compound file uses an unsupported CFB sector size"),
      );
    }

    const sectorSize = 2 ** sectorShift;
    const sectorLayout: SectorLayout = {
      bytes,
      view,
      sectorSize,
      fileSectorCount: Math.max(
        0,
        Math.floor(bytes.byteLength / sectorSize) - 1,
      ),
    };
    const fatSectorIds = yield* readDifatSectorIds(sectorLayout);
    const fat = yield* readFat(sectorLayout, fatSectorIds);
    const layout: FatLayout = { ...sectorLayout, fat };
    const directoryEntries = yield* readDirectoryEntries(layout);

    const rootEntry = directoryEntries.at(0);
    if (rootEntry?.type !== CFB_OBJECT_TYPE.root) {
      return Result.err(malformed("Compound file is missing the root storage"));
    }
    const { streams, tree } = yield* collectTree(directoryEntries, rootEntry);
    const allocated = directoryEntries.filter(
      (entry) =>
        entry.type === CFB_OBJECT_TYPE.storage ||
        entry.type === CFB_OBJECT_TYPE.stream,
    ).length;
    return Result.ok({
      layout,
      miniSectorSize: 2 ** miniSectorShift,
      miniStreamCutoff: view.getUint32(56, true) || MINI_STREAM_CUTOFF_DEFAULT,
      rootEntry,
      streamEntries: streams,
      tree,
      unreachableEntryCount: allocated - tree.length,
    });
  });

const readMiniStreamParts = (
  layout: FatLayout,
  rootEntry: CompoundFileEntry,
): ParseResult<{ miniStream: Uint8Array; miniFat: number[] }> =>
  Result.gen(function* () {
    const miniStream = yield* readRegularStream(layout, rootEntry);
    const firstMiniFatSector = layout.view.getUint32(60, true);
    const miniFat: number[] = [];
    if (
      firstMiniFatSector !== END_OF_CHAIN &&
      firstMiniFatSector !== NO_STREAM
    ) {
      const bytes = yield* readSectorChain(layout, firstMiniFatSector);
      const view = dataViewFor(bytes);
      for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 4) {
        miniFat.push(view.getUint32(offset, true));
      }
    }
    return Result.ok({ miniStream, miniFat });
  });

const readDifatSectorIds = (layout: SectorLayout): ParseResult<number[]> => {
  const { view: header, sectorSize, fileSectorCount } = layout;
  const fatSectorCount = header.getUint32(44, true);
  // One FAT sector maps `sectorSize / 4` sectors; a FAT that needs more
  // sectors than the file holds cannot describe this file.
  const maxFatSectors = Math.ceil(fileSectorCount / (sectorSize / 4)) + 1;
  if (fatSectorCount > maxFatSectors) {
    return Result.err(malformed("Compound file FAT is larger than the file"));
  }

  const difat: number[] = [];
  for (let index = 0; index < HEADER_DIFAT_ENTRIES; index += 1) {
    const sectorId = header.getUint32(76 + index * 4, true);
    if (sectorId !== NO_STREAM) {
      difat.push(sectorId);
    }
  }

  let nextDifatSector = header.getUint32(68, true);
  let remainingDifatSectors = header.getUint32(72, true);
  const entriesPerDifatSector = sectorSize / 4 - 1;
  const seen = new Set<number>();

  while (
    nextDifatSector !== END_OF_CHAIN &&
    nextDifatSector !== NO_STREAM &&
    remainingDifatSectors > 0 &&
    difat.length < fatSectorCount
  ) {
    if (seen.has(nextDifatSector)) {
      return Result.err(
        malformed("Compound file DIFAT chain revisits a sector"),
      );
    }
    seen.add(nextDifatSector);
    const sector = readSector(layout, nextDifatSector);
    if (Result.isError(sector)) {
      return sector;
    }
    const view = dataViewFor(sector.value);
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

  return Result.ok(difat.slice(0, fatSectorCount));
};

const readFat = (
  layout: SectorLayout,
  fatSectorIds: readonly number[],
): ParseResult<number[]> => {
  const fat: number[] = [];
  for (const sectorId of fatSectorIds) {
    const sector = readSector(layout, sectorId);
    if (Result.isError(sector)) {
      return sector;
    }
    const view = dataViewFor(sector.value);
    for (let offset = 0; offset < sector.value.byteLength; offset += 4) {
      fat.push(view.getUint32(offset, true));
    }
  }
  return Result.ok(fat);
};

const readDirectoryEntries = (
  layout: FatLayout,
): ParseResult<CompoundFileEntry[]> =>
  Result.gen(function* () {
    const maxDirectorySectors = Math.ceil(
      (MAX_DIRECTORY_ENTRIES * DIRECTORY_ENTRY_BYTES) / layout.sectorSize,
    );
    const directoryBytes = yield* readSectorChain(
      layout,
      layout.view.getUint32(48, true),
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
      const streamSize = yield* readDirectoryStreamSize(view);

      entries.push({
        id: entries.length,
        name,
        type: view.getUint8(66),
        leftSiblingId: view.getUint32(68, true),
        rightSiblingId: view.getUint32(72, true),
        childId: view.getUint32(76, true),
        startSector: view.getUint32(116, true),
        streamSize,
      });
    }

    return Result.ok(entries);
  });

/**
 * Walks the directory's sibling trees in order (left, self, children, right)
 * with an explicit stack. An entry is visited once, so a tree that links back
 * to itself ends instead of looping.
 */
const collectTree = (
  directoryEntries: readonly CompoundFileEntry[],
  rootEntry: CompoundFileEntry,
): ParseResult<{
  streams: CompoundFileStream[];
  tree: CompoundFileTreeEntry[];
}> => {
  type Task =
    | { kind: "visit"; id: number; path: string[] }
    | { kind: "emit"; entry: CompoundFileEntry; path: string[] };
  const streamEntries: CompoundFileStream[] = [];
  const tree: CompoundFileTreeEntry[] = [];
  const visited = new Set<number>();
  const stack: Task[] = [{ kind: "visit", id: rootEntry.childId, path: [] }];

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
    const entry = directoryEntries.at(task.id);
    if (!entry) {
      continue;
    }
    visited.add(task.id);
    tree.push({
      path: [...task.path, entry.name],
      kind: treeEntryKind(entry.type),
    });

    stack.push({ kind: "visit", id: entry.rightSiblingId, path: task.path });
    if (entry.type === CFB_OBJECT_TYPE.storage) {
      if (task.path.length >= MAX_STORAGE_DEPTH) {
        return Result.err(
          limit("Compound file storages nest past the depth limit"),
        );
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

  return Result.ok({ streams: streamEntries, tree });
};

const readRegularStream = (
  layout: FatLayout,
  entry: CompoundFileEntry,
): ParseResult<Uint8Array> => {
  if (entry.streamSize === 0 || entry.startSector === END_OF_CHAIN) {
    return Result.ok(new Uint8Array());
  }
  return readSectorChain(layout, entry.startSector).map((bytes) =>
    bytes.slice(0, entry.streamSize),
  );
};

const readSectorChain = (
  layout: FatLayout,
  firstSector: number,
  maxSectors = MAX_CHAIN_SECTORS,
  limitMessage = "Compound file stream exceeds the sector chain limit",
): ParseResult<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  const seen = new Set<number>();
  let sectorId = firstSector;

  while (sectorId !== END_OF_CHAIN) {
    if (sectorId === NO_STREAM || sectorId === FAT_SECTOR) {
      return Result.err(
        malformed("Compound file stream has an invalid sector chain"),
      );
    }
    if (sectorId >= layout.fat.length || seen.has(sectorId)) {
      return Result.err(
        malformed("Compound file stream references an invalid FAT sector"),
      );
    }
    if (seen.size >= maxSectors) {
      return Result.err(limit(limitMessage));
    }
    seen.add(sectorId);
    const sector = readSector(layout, sectorId);
    if (Result.isError(sector)) {
      return sector;
    }
    chunks.push(sector.value);
    sectorId = layout.fat[sectorId] ?? END_OF_CHAIN;
  }

  return Result.ok(concatChunks(chunks));
};

const readSector = (
  layout: SectorLayout,
  sectorId: number,
): ParseResult<Uint8Array> => {
  const offset = (sectorId + 1) * layout.sectorSize;
  const end = offset + layout.sectorSize;
  if (end > layout.bytes.byteLength) {
    return Result.err(
      malformed("Compound file sector points outside the file"),
    );
  }
  return Result.ok(layout.bytes.subarray(offset, end));
};

const treeEntryKind = (type: number): CompoundFileTreeEntry["kind"] => {
  if (type === CFB_OBJECT_TYPE.storage) {
    return "storage";
  }
  if (type === CFB_OBJECT_TYPE.stream) {
    return "stream";
  }
  return "other";
};

const readDirectoryStreamSize = (view: DataView): ParseResult<number> => {
  const low = view.getUint32(120, true);
  const high = view.getUint32(124, true);
  if (high === 0) {
    return Result.ok(low);
  }

  const size = BigInt(high) * UINT32_RANGE + BigInt(low);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Result.err(
      malformed("Compound file stream is too large to parse safely"),
    );
  }
  return Result.ok(Number(size));
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
