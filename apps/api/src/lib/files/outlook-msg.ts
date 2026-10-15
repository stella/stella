import { Result } from "better-result";

import { CompoundFile } from "@/api/lib/files/compound-file";
import type { CompoundFileParseError } from "@/api/lib/files/compound-file";

const UINT32_RANGE = 4_294_967_296n;

const RECIPIENT_TYPE = {
  to: 1,
  cc: 2,
  bcc: 3,
} as const;

const RECIPIENT_STORAGE_PREFIX = "__recip_version1.0_";
const ATTACHMENT_STORAGE_PREFIX = "__attach_version1.0_";
const PROPERTY_STREAM_RE = /^__substg1\.0_(?<tag>[0-9a-f]{8})$/iu;

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
  internetMessageId: "1035",
  inReplyToId: "1042",
  internetReferences: "1039",
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

type OutlookMsgAttachment = {
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
  bcc: OutlookMsgRecipient[];
  date: string | null;
  /** The sender's submit time, the counterpart of an RFC 5322 Date header. */
  submittedAt: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  html: string | null;
  text: string | null;
  attachments: OutlookMsgAttachment[];
};

type MsgProperty = {
  id: string;
  type: string;
  bytes: Uint8Array;
};

/**
 * The .msg parser's callers (`parseEmail`) convert a thrown parse error at
 * their boundary, so a typed reader failure surfaces here as that error.
 */
const unwrapParse = <T>(result: Result<T, CompoundFileParseError>): T => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

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
    const propertyTag = match.groups?.["tag"]?.toLowerCase();
    if (!propertyTag) {
      continue;
    }

    const property = {
      id: propertyTag.slice(0, 4),
      type: propertyTag.slice(4, 8),
      bytes: unwrapParse(compoundFile.readStream(streamEntry.entry)),
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

/** @throws {CompoundFileParseError} when the container is malformed or a limit is reached */
export const parseOutlookMsg = (fileBuffer: ArrayBuffer): OutlookMsgEmail => {
  const compoundFile = unwrapParse(
    CompoundFile.parse(new Uint8Array(fileBuffer)),
  );
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
    bcc: recipients.filter((recipient) => recipient.type === "bcc"),
    date:
      getFileTime(rootProperties, PROPERTY_ID.messageDeliveryTime) ??
      getFileTime(rootProperties, PROPERTY_ID.clientSubmitTime),
    submittedAt: getFileTime(rootProperties, PROPERTY_ID.clientSubmitTime),
    messageId: getString(rootProperties, PROPERTY_ID.internetMessageId),
    inReplyTo: getString(rootProperties, PROPERTY_ID.inReplyToId),
    references: getString(rootProperties, PROPERTY_ID.internetReferences),
    html:
      getString(rootProperties, PROPERTY_ID.bodyHtml) ??
      getBinaryText(rootProperties, PROPERTY_ID.bodyHtml),
    text: getString(rootProperties, PROPERTY_ID.body),
    attachments,
  };
};
