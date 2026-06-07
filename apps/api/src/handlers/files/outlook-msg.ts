import { TaggedError } from "better-result";

const CFB_SIGNATURE = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

const NO_STREAM = 4_294_967_295;
const END_OF_CHAIN = 4_294_967_294;
const FAT_SECTOR = 4_294_967_293;
const MAX_CHAIN_SECTORS = 65_536;
const MAX_DIRECTORY_ENTRIES = 16_384;
const DIRECTORY_ENTRY_BYTES = 128;
const HEADER_DIFAT_ENTRIES = 109;
const MINI_STREAM_CUTOFF_DEFAULT = 4096;
const UINT32_RANGE = 4_294_967_296n;

const CFB_OBJECT_TYPE = {
  storage: 1,
  stream: 2,
  root: 5,
} as const;

const RECIPIENT_TYPE = {
  to: 1,
  cc: 2,
  bcc: 3,
} as const;

const RECIPIENT_STORAGE_PREFIX = "__recip_version1.0_";
const ATTACHMENT_STORAGE_PREFIX = "__attach_version1.0_";
const PROPERTY_STREAM_RE = /^__substg1\.0_([0-9a-f]{8})$/iu;

const PROPERTY_TYPE = {
  int32: "0003",
  fileTime: "0040",
  ansiString: "001e",
  unicodeString: "001f",
  binary: "0102",
} as const;

const PROPERTY_ID = {
  subject: "0037",
  senderName: "0c1a",
  senderEmail: "0c1f",
  senderSmtpAddress: "5d01",
  body: "1000",
  bodyHtml: "1013",
  clientSubmitTime: "0039",
  messageDeliveryTime: "0e06",
  recipientType: "0c15",
  displayName: "3001",
  email: "3003",
  smtpAddress: "39fe",
  attachmentData: "3701",
  attachmentFilename: "3707",
  attachmentShortFilename: "3704",
  attachmentContentId: "3712",
  attachmentMimeTag: "370e",
} as const;

export class OutlookMsgParseError extends TaggedError("OutlookMsgParseError")<{
  message: string;
}>() {}

export type OutlookMsgAttachment = {
  contentId: string | null;
  fileName: string | null;
  mimeType: string | null;
  bytes: Uint8Array | null;
};

export type OutlookMsgRecipient = {
  name: string | null;
  email: string | null;
  type: "to" | "cc" | "bcc";
};

export type OutlookMsgEmail = {
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  to: OutlookMsgRecipient[];
  cc: OutlookMsgRecipient[];
  date: string | null;
  html: string | null;
  text: string | null;
  attachments: OutlookMsgAttachment[];
};

type DirectoryEntry = {
  id: number;
  name: string;
  type: number;
  leftSiblingId: number;
  rightSiblingId: number;
  childId: number;
  startSector: number;
  streamSize: number;
};

type StreamEntry = {
  entry: DirectoryEntry;
  path: string[];
};

type MsgProperty = {
  id: string;
  type: string;
  bytes: Uint8Array;
};

export const parseOutlookMsg = (fileBuffer: ArrayBuffer): OutlookMsgEmail => {
  const compoundFile = new CompoundFile(new Uint8Array(fileBuffer));
  const rootProperties = collectProperties(compoundFile, []);
  const recipients = readRecipients(compoundFile);
  const attachments = readAttachments(compoundFile);

  return {
    subject: getString(rootProperties, PROPERTY_ID.subject),
    fromName: getString(rootProperties, PROPERTY_ID.senderName),
    fromEmail:
      getString(rootProperties, PROPERTY_ID.senderSmtpAddress) ??
      getString(rootProperties, PROPERTY_ID.senderEmail),
    to: recipients.filter((recipient) => recipient.type === "to"),
    cc: recipients.filter((recipient) => recipient.type === "cc"),
    date:
      getFileTime(rootProperties, PROPERTY_ID.messageDeliveryTime) ??
      getFileTime(rootProperties, PROPERTY_ID.clientSubmitTime),
    html:
      getString(rootProperties, PROPERTY_ID.bodyHtml) ??
      getBinaryText(rootProperties, PROPERTY_ID.bodyHtml),
    text: getString(rootProperties, PROPERTY_ID.body),
    attachments,
  };
};

class CompoundFile {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniStreamCutoff: number;
  private readonly fat: number[];
  private readonly miniFat: number[];
  private readonly directoryEntries: DirectoryEntry[];
  private readonly miniStream: Uint8Array;
  readonly streamEntries: StreamEntry[];

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.assertHeader();

    this.sectorSize = 2 ** this.readUint16(30);
    this.miniSectorSize = 2 ** this.readUint16(32);
    this.miniStreamCutoff = this.readUint32(56) || MINI_STREAM_CUTOFF_DEFAULT;

    const fatSectorIds = this.readDifatSectorIds();
    this.fat = this.readFat(fatSectorIds);
    this.directoryEntries = this.readDirectoryEntries();

    const rootEntry = this.directoryEntries.find(
      (entry) => entry.type === CFB_OBJECT_TYPE.root,
    );
    if (!rootEntry) {
      throw new OutlookMsgParseError({
        message: "Outlook .msg file is missing the root storage",
      });
    }

    this.miniStream = this.readRegularStream(rootEntry);
    this.miniFat = this.readMiniFat();
    this.streamEntries = this.collectStreamEntries(rootEntry);
  }

  readStream(entry: DirectoryEntry): Uint8Array {
    if (entry.streamSize >= this.miniStreamCutoff) {
      return this.readRegularStream(entry);
    }
    return this.readMiniStream(entry);
  }

  private assertHeader(): void {
    if (this.bytes.byteLength < 512) {
      throw new OutlookMsgParseError({
        message: "Outlook .msg file is too small to contain a CFB header",
      });
    }

    for (let index = 0; index < CFB_SIGNATURE.byteLength; index += 1) {
      if (this.bytes[index] !== CFB_SIGNATURE[index]) {
        throw new OutlookMsgParseError({
          message: "Outlook .msg file has an invalid CFB signature",
        });
      }
    }
  }

  private readDifatSectorIds(): number[] {
    const fatSectorCount = this.readUint32(44);
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

    while (
      nextDifatSector !== END_OF_CHAIN &&
      nextDifatSector !== NO_STREAM &&
      remainingDifatSectors > 0 &&
      difat.length < fatSectorCount
    ) {
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

  private readMiniFat(): number[] {
    const firstMiniFatSector = this.readUint32(60);
    if (
      firstMiniFatSector === END_OF_CHAIN ||
      firstMiniFatSector === NO_STREAM
    ) {
      return [];
    }

    const bytes = this.readSectorChain(firstMiniFatSector, this.fat);
    const miniFat: number[] = [];
    const view = dataViewFor(bytes);
    for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 4) {
      miniFat.push(view.getUint32(offset, true));
    }
    return miniFat;
  }

  private readDirectoryEntries(): DirectoryEntry[] {
    const firstDirectorySector = this.readUint32(48);
    const directoryBytes = this.readSectorChain(firstDirectorySector, this.fat);
    const entries: DirectoryEntry[] = [];

    for (
      let offset = 0;
      offset + DIRECTORY_ENTRY_BYTES <= directoryBytes.byteLength;
      offset += DIRECTORY_ENTRY_BYTES
    ) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) {
        throw new OutlookMsgParseError({
          message: "Outlook .msg directory exceeds the entry limit",
        });
      }

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

  private collectStreamEntries(rootEntry: DirectoryEntry): StreamEntry[] {
    const streamEntries: StreamEntry[] = [];
    const visited = new Set<number>();

    const visitTree = (entryId: number, path: string[]): void => {
      if (entryId === NO_STREAM || visited.has(entryId)) {
        return;
      }
      const entry = this.directoryEntries.at(entryId);
      if (!entry) {
        return;
      }
      visited.add(entryId);

      visitTree(entry.leftSiblingId, path);

      if (entry.type === CFB_OBJECT_TYPE.stream) {
        streamEntries.push({ entry, path: [...path, entry.name] });
      }

      if (entry.type === CFB_OBJECT_TYPE.storage) {
        visitTree(entry.childId, [...path, entry.name]);
      }

      visitTree(entry.rightSiblingId, path);
    };

    visitTree(rootEntry.childId, []);
    return streamEntries;
  }

  private readRegularStream(entry: DirectoryEntry): Uint8Array {
    if (entry.streamSize === 0 || entry.startSector === END_OF_CHAIN) {
      return new Uint8Array();
    }
    return this.readSectorChain(entry.startSector, this.fat).slice(
      0,
      entry.streamSize,
    );
  }

  private readMiniStream(entry: DirectoryEntry): Uint8Array {
    if (entry.streamSize === 0 || entry.startSector === END_OF_CHAIN) {
      return new Uint8Array();
    }

    const chunks: Uint8Array[] = [];
    const seen = new Set<number>();
    let sectorId = entry.startSector;

    while (sectorId !== END_OF_CHAIN) {
      if (sectorId === NO_STREAM || seen.has(sectorId)) {
        throw new OutlookMsgParseError({
          message: "Outlook .msg mini stream has an invalid sector chain",
        });
      }
      if (seen.size >= MAX_CHAIN_SECTORS) {
        throw new OutlookMsgParseError({
          message: "Outlook .msg mini stream exceeds the sector chain limit",
        });
      }
      if (sectorId >= this.miniFat.length) {
        throw new OutlookMsgParseError({
          message:
            "Outlook .msg mini stream references a missing mini FAT entry",
        });
      }
      const offset = sectorId * this.miniSectorSize;
      const end = offset + this.miniSectorSize;
      if (end > this.miniStream.byteLength) {
        throw new OutlookMsgParseError({
          message:
            "Outlook .msg mini stream references bytes outside the root stream",
        });
      }
      seen.add(sectorId);
      chunks.push(this.miniStream.subarray(offset, end));
      sectorId = this.miniFat[sectorId] ?? END_OF_CHAIN;
    }

    return concatChunks(chunks).slice(0, entry.streamSize);
  }

  private readSectorChain(firstSector: number, fat: number[]): Uint8Array {
    const chunks: Uint8Array[] = [];
    const seen = new Set<number>();
    let sectorId = firstSector;

    while (sectorId !== END_OF_CHAIN) {
      if (sectorId === NO_STREAM || sectorId === FAT_SECTOR) {
        throw new OutlookMsgParseError({
          message: "Outlook .msg stream has an invalid sector chain",
        });
      }
      if (sectorId >= fat.length || seen.has(sectorId)) {
        throw new OutlookMsgParseError({
          message: "Outlook .msg stream references an invalid FAT sector",
        });
      }
      if (seen.size >= MAX_CHAIN_SECTORS) {
        throw new OutlookMsgParseError({
          message: "Outlook .msg stream exceeds the sector chain limit",
        });
      }
      seen.add(sectorId);
      chunks.push(this.readSector(sectorId));
      sectorId = fat[sectorId] ?? END_OF_CHAIN;
    }

    return concatChunks(chunks);
  }

  private readSector(sectorId: number): Uint8Array {
    const offset = (sectorId + 1) * this.sectorSize;
    const end = offset + this.sectorSize;
    if (end > this.bytes.byteLength) {
      throw new OutlookMsgParseError({
        message: "Outlook .msg sector points outside the file",
      });
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

const collectProperties = (
  compoundFile: CompoundFile,
  storagePath: string[],
): Map<string, MsgProperty> => {
  const properties = new Map<string, MsgProperty>();
  for (const streamEntry of compoundFile.streamEntries) {
    if (!isDirectChildPath(storagePath, streamEntry.path)) {
      continue;
    }

    const name = streamEntry.path.at(-1);
    if (!name) {
      continue;
    }
    const match = PROPERTY_STREAM_RE.exec(name);
    if (!match) {
      continue;
    }
    const propertyTag = match[1]?.toLowerCase();
    if (!propertyTag) {
      continue;
    }

    const property = {
      id: propertyTag.slice(0, 4),
      type: propertyTag.slice(4, 8),
      bytes: compoundFile.readStream(streamEntry.entry),
    };
    properties.set(propertyTag, property);
  }
  return properties;
};

const readRecipients = (compoundFile: CompoundFile): OutlookMsgRecipient[] => {
  const recipientPaths = directStoragePaths(
    compoundFile,
    RECIPIENT_STORAGE_PREFIX,
  );
  const recipients: OutlookMsgRecipient[] = [];

  for (const path of recipientPaths) {
    const properties = collectProperties(compoundFile, path);

    recipients.push({
      name: getString(properties, PROPERTY_ID.displayName),
      email:
        getString(properties, PROPERTY_ID.smtpAddress) ??
        getString(properties, PROPERTY_ID.email),
      type: getRecipientKind(getInt32(properties, PROPERTY_ID.recipientType)),
    });
  }

  return recipients;
};

const readAttachments = (
  compoundFile: CompoundFile,
): OutlookMsgAttachment[] => {
  const attachmentPaths = directStoragePaths(
    compoundFile,
    ATTACHMENT_STORAGE_PREFIX,
  );
  const attachments: OutlookMsgAttachment[] = [];

  for (const path of attachmentPaths) {
    const properties = collectProperties(compoundFile, path);
    attachments.push({
      contentId: getString(properties, PROPERTY_ID.attachmentContentId),
      fileName:
        getString(properties, PROPERTY_ID.attachmentFilename) ??
        getString(properties, PROPERTY_ID.attachmentShortFilename),
      mimeType: getString(properties, PROPERTY_ID.attachmentMimeTag),
      bytes: getBinary(properties, PROPERTY_ID.attachmentData),
    });
  }

  return attachments;
};

const directStoragePaths = (
  compoundFile: CompoundFile,
  storagePrefix: string,
): string[][] => {
  const storageNames = new Set<string>();
  for (const streamEntry of compoundFile.streamEntries) {
    const storageName = streamEntry.path.at(0);
    if (streamEntry.path.length > 1 && storageName?.startsWith(storagePrefix)) {
      storageNames.add(storageName);
    }
  }
  return [...storageNames].toSorted().map((name) => [name]);
};

const isDirectChildPath = (
  parentPath: string[],
  childPath: string[],
): boolean => {
  if (childPath.length !== parentPath.length + 1) {
    return false;
  }
  return parentPath.every((part, index) => childPath[index] === part);
};

const getProperty = (
  properties: Map<string, MsgProperty>,
  propertyId: string,
  type: string,
): MsgProperty | undefined => properties.get(`${propertyId}${type}`);

const getRecipientKind = (
  recipientType: number | null,
): OutlookMsgRecipient["type"] => {
  if (recipientType === RECIPIENT_TYPE.cc) {
    return "cc";
  }
  if (recipientType === RECIPIENT_TYPE.bcc) {
    return "bcc";
  }
  return "to";
};

const getString = (
  properties: Map<string, MsgProperty>,
  propertyId: string,
): string | null => {
  const unicode = getProperty(
    properties,
    propertyId,
    PROPERTY_TYPE.unicodeString,
  );
  if (unicode) {
    return normalizeString(decodeUtf16(unicode.bytes));
  }

  const ansi = getProperty(properties, propertyId, PROPERTY_TYPE.ansiString);
  if (ansi) {
    return normalizeString(decodeAnsi(ansi.bytes));
  }

  return null;
};

const getBinaryText = (
  properties: Map<string, MsgProperty>,
  propertyId: string,
): string | null => {
  const property = getProperty(properties, propertyId, PROPERTY_TYPE.binary);
  if (!property) {
    return null;
  }
  return normalizeString(new TextDecoder().decode(property.bytes));
};

const getBinary = (
  properties: Map<string, MsgProperty>,
  propertyId: string,
): Uint8Array | null =>
  getProperty(properties, propertyId, PROPERTY_TYPE.binary)?.bytes ?? null;

const getInt32 = (
  properties: Map<string, MsgProperty>,
  propertyId: string,
): number | null => {
  const property = getProperty(properties, propertyId, PROPERTY_TYPE.int32);
  if (!property || property.bytes.byteLength < 4) {
    return null;
  }
  return dataViewFor(property.bytes).getInt32(0, true);
};

const getFileTime = (
  properties: Map<string, MsgProperty>,
  propertyId: string,
): string | null => {
  const property = getProperty(properties, propertyId, PROPERTY_TYPE.fileTime);
  if (!property || property.bytes.byteLength < 8) {
    return null;
  }

  const view = dataViewFor(property.bytes);
  const low = BigInt(view.getUint32(0, true));
  const high = BigInt(view.getUint32(4, true));
  const fileTime = high * UINT32_RANGE + low;
  if (fileTime === 0n) {
    return null;
  }

  const windowsEpochOffsetMs = 11_644_473_600_000n;
  const unixMs = fileTime / 10_000n - windowsEpochOffsetMs;
  return new Date(Number(unixMs)).toUTCString();
};

const readDirectoryStreamSize = (view: DataView): number => {
  const low = view.getUint32(120, true);
  const high = view.getUint32(124, true);
  if (high === 0) {
    return low;
  }

  const size = BigInt(high) * UINT32_RANGE + BigInt(low);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OutlookMsgParseError({
      message: "Outlook .msg stream is too large to parse safely",
    });
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

const decodeAnsi = (bytes: Uint8Array): string =>
  new TextDecoder("windows-1252").decode(bytes);

const normalizeString = (value: string): string | null => {
  const trimmed = value.replaceAll("\u0000", "").trim();
  return trimmed.length > 0 ? trimmed : null;
};

const dataViewFor = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
