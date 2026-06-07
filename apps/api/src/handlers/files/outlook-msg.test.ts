import { describe, expect, test } from "bun:test";

import { parseOutlookMsg } from "./outlook-msg";

const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const DIRECTORY_ENTRY_BYTES = 128;
const NO_STREAM = 4_294_967_295;
const END_OF_CHAIN = 4_294_967_294;
const FAT_SECTOR = 4_294_967_293;
const FREE_SECTOR = 4_294_967_295;
const UINT32_RANGE = 4_294_967_296n;

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

describe("parseOutlookMsg", () => {
  test("reads common message, recipient, and inline attachment properties", () => {
    const file = buildMsgFile([
      rootProperty("0037", "001f", utf16Property("Contract draft")),
      rootProperty("0c1a", "001f", utf16Property("Jane Lawyer")),
      rootProperty("5d01", "001f", utf16Property("jane@example.com")),
      rootProperty("0e06", "0040", fileTimeProperty("2026-06-02T10:00:00Z")),
      rootProperty(
        "1013",
        "001f",
        utf16Property('<p>Hello <b>world</b></p><img src="cid:logo">'),
      ),
      storageProperty("__recip_version1.0_00000000", "0c15", "0003", int32(1)),
      storageProperty(
        "__recip_version1.0_00000000",
        "3001",
        "001f",
        utf16Property("Client One"),
      ),
      storageProperty(
        "__recip_version1.0_00000000",
        "39fe",
        "001f",
        utf16Property("client@example.org"),
      ),
      storageProperty("__recip_version1.0_00000001", "0c15", "0003", int32(2)),
      storageProperty(
        "__recip_version1.0_00000001",
        "3003",
        "001f",
        utf16Property("copy@example.org"),
      ),
      storageProperty(
        "__attach_version1.0_00000000",
        "3712",
        "001f",
        utf16Property("logo"),
      ),
      storageProperty(
        "__attach_version1.0_00000000",
        "370e",
        "001f",
        utf16Property("image/png"),
      ),
      storageProperty(
        "__attach_version1.0_00000000",
        "3707",
        "001f",
        utf16Property("logo.png"),
      ),
      storageProperty(
        "__attach_version1.0_00000000",
        "3701",
        "0102",
        PNG_BYTES,
      ),
    ]);

    const message = parseOutlookMsg(toArrayBuffer(file));

    expect(message.subject).toBe("Contract draft");
    expect(message.fromName).toBe("Jane Lawyer");
    expect(message.fromEmail).toBe("jane@example.com");
    expect(message.date).toBe("Tue, 02 Jun 2026 10:00:00 GMT");
    expect(message.html).toContain("Hello <b>world</b>");
    expect(message.to).toEqual([
      { name: "Client One", email: "client@example.org", type: "to" },
    ]);
    expect(message.cc).toEqual([
      { name: null, email: "copy@example.org", type: "cc" },
    ]);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments.at(0)).toMatchObject({
      contentId: "logo",
      fileName: "logo.png",
      mimeType: "image/png",
    });
    expect(message.attachments.at(0)?.bytes).toEqual(PNG_BYTES);
  });
});

type TestStream = {
  path: string[];
  bytes: Uint8Array;
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

const rootProperty = (
  propertyId: string,
  propertyType: string,
  bytes: Uint8Array,
): TestStream => ({
  path: [`__substg1.0_${propertyId}${propertyType}`],
  bytes,
});

const storageProperty = (
  storageName: string,
  propertyId: string,
  propertyType: string,
  bytes: Uint8Array,
): TestStream => ({
  path: [storageName, `__substg1.0_${propertyId}${propertyType}`],
  bytes,
});

const buildMsgFile = (streams: TestStream[]): Uint8Array => {
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
    throw new Error("test fixture must include a root directory record");
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

const buildDirectoryRecords = (streams: TestStream[]): DirectoryRecord[] => {
  const records: DirectoryRecord[] = [directoryRecord("Root Entry", 5)];
  const rootChildIds: number[] = [];
  const storageChildIds = new Map<string, number[]>();
  const storageIds = new Map<string, number>();

  for (const stream of streams) {
    if (stream.path.length === 1) {
      const streamName = stream.path.at(0);
      if (!streamName) {
        throw new Error("test fixture root stream must have a name");
      }
      const id = records.length;
      records.push(streamRecord(streamName, stream.bytes));
      rootChildIds.push(id);
      continue;
    }

    const storageName = stream.path[0];
    const streamName = stream.path[1];
    if (!storageName || !streamName) {
      continue;
    }

    let storageId = storageIds.get(storageName);
    if (storageId === undefined) {
      storageId = records.length;
      records.push(directoryRecord(storageName, 1));
      storageIds.set(storageName, storageId);
      storageChildIds.set(storageName, []);
      rootChildIds.push(storageId);
    }

    const streamId = records.length;
    records.push(streamRecord(streamName, stream.bytes));
    storageChildIds.get(storageName)?.push(streamId);
  }

  const root = records.at(0);
  if (!root) {
    throw new Error("test fixture must include a root directory record");
  }
  root.childId = linkSiblings(records, rootChildIds);
  for (const [storageName, childIds] of storageChildIds) {
    const storageId = storageIds.get(storageName);
    const storageRecord =
      storageId === undefined ? undefined : records.at(storageId);
    if (storageRecord) {
      storageRecord.childId = linkSiblings(records, childIds);
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
      throw new Error(
        "test fixture sibling id must reference a directory record",
      );
    }
    record.rightSiblingId = ids.at(index + 1) ?? NO_STREAM;
  }
  const firstId = ids.at(0);
  if (firstId === undefined) {
    throw new Error("test fixture sibling list unexpectedly lost its first id");
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

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
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

const utf16Property = (value: string): Uint8Array =>
  Buffer.from(`${value}\u0000`, "utf16le");

const int32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
};

const fileTimeProperty = (isoDate: string): Uint8Array => {
  const unixMs = BigInt(new Date(isoDate).getTime());
  const windowsEpochOffsetMs = 11_644_473_600_000n;
  const fileTime = (unixMs + windowsEpochOffsetMs) * 10_000n;
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Number(fileTime % UINT32_RANGE), true);
  view.setUint32(4, Number(fileTime / UINT32_RANGE), true);
  return bytes;
};
