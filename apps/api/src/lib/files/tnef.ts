/**
 * A reader for Outlook's Transport-Neutral Encapsulation Format ([MS-OXTNEF]):
 * the `winmail.dat` stream Outlook attaches to a message, or sends alone. A
 * stream is a signature, then attributes, each a level (message or
 * attachment), an id whose high word is its type, a length, the data and a
 * checksum. Message attributes and the MAPI properties in `attMsgProps` give
 * the subject, sender, recipients, date and body; every `attAttachRendData`
 * starts an attachment whose legacy attributes (`attAttachTitle`,
 * `attAttachData`) and MAPI properties (`attAttachment`) give its name, type,
 * content ID and bytes. An attached message (`PidTagAttachDataObject`) is
 * kept whole, as the TNEF stream it is, to be read in turn.
 *
 * Every count and length is bounded before anything is read: attributes,
 * attachments, properties per list, values per property, and each value by
 * the bytes left in its attribute.
 */
import { Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";
import { Temporal } from "@stll/time";

import { decompressRtf } from "@/api/lib/files/rtf-compressed";

export class TnefParseError extends TaggedError("TnefParseError")<{
  message: string;
  reason: "invalid" | "limit";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

/** The signature every TNEF stream opens with, little-endian. */
export const TNEF_SIGNATURE = 0x22_3e_9f_78;

/** Whether bytes open as a TNEF stream. */
export const hasTnefSignature = (bytes: Uint8Array): boolean =>
  bytes.byteLength >= 6 &&
  new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) ===
    TNEF_SIGNATURE;

export const TNEF_LIMITS = {
  attributes: 10_000,
  attachments: 1000,
  propertiesPerList: 4096,
  valuesPerProperty: 4096,
  recipients: 4096,
  rtfBytes: 16 * 1024 * 1024,
} as const;

const LEVEL_MESSAGE = 1;
const LEVEL_ATTACHMENT = 2;

/** Attribute ids, the low word of an attribute's id ([MS-OXTNEF] 2.1.3.2). */
const ATTRIBUTE = {
  from: 0x80_00,
  subject: 0x80_04,
  dateSent: 0x80_05,
  messageClass: 0x80_08,
  body: 0x80_0c,
  attachData: 0x80_0f,
  attachTitle: 0x80_10,
  attachTransportFilename: 0x90_01,
  attachRendData: 0x90_02,
  msgProps: 0x90_03,
  recipTable: 0x90_04,
  attachment: 0x90_05,
  oemCodepage: 0x90_07,
} as const;

/** MAPI property types ([MS-OXCDATA] 2.11.1). */
const TYPE = {
  int16: 0x00_02,
  int32: 0x00_03,
  float32: 0x00_04,
  float64: 0x00_05,
  currency: 0x00_06,
  appTime: 0x00_07,
  error: 0x00_0a,
  boolean: 0x00_0b,
  object: 0x00_0d,
  int64: 0x00_14,
  string8: 0x00_1e,
  unicode: 0x00_1f,
  sysTime: 0x00_40,
  guid: 0x00_48,
  binary: 0x01_02,
  multiple: 0x10_00,
} as const;

const FIXED_SIZES: ReadonlyMap<number, number> = new Map([
  [TYPE.int16, 4],
  [TYPE.int32, 4],
  [TYPE.float32, 4],
  [TYPE.float64, 8],
  [TYPE.currency, 8],
  [TYPE.appTime, 8],
  [TYPE.error, 4],
  [TYPE.boolean, 4],
  [TYPE.int64, 8],
  [TYPE.sysTime, 8],
  [TYPE.guid, 16],
]);

const VARIABLE_TYPES: ReadonlySet<number> = new Set([
  TYPE.object,
  TYPE.string8,
  TYPE.unicode,
  TYPE.binary,
]);

/** MAPI property ids the reader keeps ([MS-OXPROPS]). */
const PROPERTY = {
  subject: 0x00_37,
  clientSubmitTime: 0x00_39,
  sentRepresentingName: 0x00_42,
  sentRepresentingEmail: 0x00_65,
  senderName: 0x0c_1a,
  senderEmail: 0x0c_1f,
  recipientType: 0x0c_15,
  deliveryTime: 0x0e_06,
  body: 0x10_00,
  rtfCompressed: 0x10_09,
  bodyHtml: 0x10_13,
  displayName: 0x30_01,
  emailAddress: 0x30_03,
  attachData: 0x37_01,
  attachFilename: 0x37_04,
  attachMethod: 0x37_05,
  attachLongFilename: 0x37_07,
  attachMimeTag: 0x37_0e,
  attachContentId: 0x37_12,
  internetCodepage: 0x3f_de,
  smtpAddress: 0x39_fe,
  senderSmtpAddress: 0x5d_01,
  attachmentHidden: 0x7f_fe,
  messageClass: 0x00_1a,
} as const;

/** `PidTagAttachMethod`: the attachment is a message of its own. */
const ATTACH_EMBEDDED_MESSAGE = 5;

/** IID_IMessage: the interface an attached message's object starts with. */
const IID_IMESSAGE = Uint8Array.from([
  0x07, 0x03, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x46,
]);
const IID_BYTES = 16;

type PropertyValue =
  | { kind: "string8"; bytes: Uint8Array }
  | { kind: "unicode"; text: string }
  | { kind: "binary"; bytes: Uint8Array }
  | { kind: "object"; bytes: Uint8Array }
  | { kind: "int32"; value: number }
  | { kind: "time"; value: string | null }
  | { kind: "other" };

/** One property list: the first value of each property id. */
type Properties = ReadonlyMap<number, PropertyValue>;

export type TnefRecipient = {
  name: string | null;
  email: string | null;
  type: "to" | "cc" | "bcc";
};

export type TnefAttachment = {
  fileName: string | null;
  mimeType: string | null;
  contentId: string | null;
  /** The attachment's bytes; an attached message is its own TNEF stream. */
  bytes: Uint8Array;
  /** An attached message (`ATTACH_EMBEDDED_MSG`), kept whole. */
  message: boolean;
  /** Hidden from the list of attachments, such as an image of the body. */
  hidden: boolean;
};

export type TnefMessage = {
  messageClass: string | null;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  recipients: TnefRecipient[];
  date: string | null;
  html: string | null;
  /** The RTF body, decompressed. */
  rtf: Uint8Array | null;
  text: string | null;
  attachments: TnefAttachment[];
};

const invalid = (message: string) =>
  new TnefParseError({ message, reason: "invalid" });
const limit = (message: string) =>
  new TnefParseError({ message, reason: "limit" });

const EMPTY = new Uint8Array();

/**
 * The first failure of one read. Every cursor over the stream and its
 * attributes shares one, and a read after it returns nothing, so a parse
 * stops at the first fault without throwing.
 */
type Failure = { error: TnefParseError | null };

/** A bounded little-endian reader over one span of bytes. */
class Cursor {
  private at = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  readonly failure: Failure;

  constructor(bytes: Uint8Array, failure: Failure) {
    this.bytes = bytes;
    this.failure = failure;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.byteLength - this.at;
  }

  get failed(): boolean {
    return this.failure.error !== null;
  }

  fail(error: TnefParseError): void {
    this.failure.error ??= error;
  }

  /** Where `length` bytes start, or null when they run past the span. */
  private advance(length: number): number | null {
    if (this.failed) {
      return null;
    }
    if (length < 0 || length > this.remaining) {
      this.fail(invalid("A TNEF value runs past its data"));
      return null;
    }
    const start = this.at;
    this.at += length;
    return start;
  }

  take(length: number): Uint8Array {
    const start = this.advance(length);
    return start === null ? EMPTY : this.bytes.subarray(start, start + length);
  }

  uint8(): number {
    const start = this.advance(1);
    return start === null ? 0 : this.view.getUint8(start);
  }

  uint16(): number {
    const start = this.advance(2);
    return start === null ? 0 : this.view.getUint16(start, true);
  }

  uint32(): number {
    const start = this.advance(4);
    return start === null ? 0 : this.view.getUint32(start, true);
  }

  /** Skips to the next multiple of four from the start of the span. */
  align(): void {
    this.take((4 - (this.at % 4)) % 4);
  }

  /** A reader over `data`, sharing this one's failure. */
  over(data: Uint8Array): Cursor {
    return new Cursor(data, this.failure);
  }
}

const WINDOWS_CODE_PAGES = new Set([
  874, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258,
]);

const codePageLabel = (codePage: number): string => {
  if (codePage === 65_001) {
    return "utf-8";
  }
  return WINDOWS_CODE_PAGES.has(codePage)
    ? `windows-${String(codePage)}`
    : "windows-1252";
};

const decodeString8 = (bytes: Uint8Array, codePage: number): string =>
  new TextDecoder(codePageLabel(codePage)).decode(bytes);

/** A string without its terminating NULs and surrounding space; null if empty. */
const cleanString = (value: string): string | null => {
  // A string ends at its first NUL; what a writer leaves after it is not text.
  const cleaned = (value.split("\u0000", 1).at(0) ?? "").trim();
  return cleaned === "" ? null : cleaned;
};

const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000n;

const fileTime = (bytes: Uint8Array): string | null => {
  if (bytes.byteLength < 8) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const ticks =
    BigInt(view.getUint32(4, true)) * 4_294_967_296n +
    BigInt(view.getUint32(0, true));
  if (ticks === 0n) {
    return null;
  }
  const unixMs = Number(ticks / 10_000n - FILETIME_UNIX_EPOCH_MS);
  const date = new Date(unixMs);
  return Number.isNaN(date.getTime()) ? null : date.toUTCString();
};

/** One value of a variable-size property: its size, its bytes, padding. */
const variableValue = (cursor: Cursor): Uint8Array => {
  const size = cursor.uint32();
  const bytes = cursor.take(size);
  cursor.align();
  return bytes;
};

const readValue = (cursor: Cursor, type: number): PropertyValue => {
  const fixed = FIXED_SIZES.get(type);
  if (fixed !== undefined) {
    const bytes = cursor.take(fixed);
    if (bytes.byteLength < fixed) {
      return { kind: "other" };
    }
    if (type === TYPE.int32) {
      return {
        kind: "int32",
        value: new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(
          0,
          true,
        ),
      };
    }
    if (type === TYPE.sysTime) {
      return { kind: "time", value: fileTime(bytes) };
    }
    if (type === TYPE.boolean) {
      return {
        kind: "int32",
        value: new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(
          0,
          true,
        ),
      };
    }
    return { kind: "other" };
  }
  const bytes = variableValue(cursor);
  switch (type) {
    case TYPE.string8:
      return { kind: "string8", bytes };
    case TYPE.unicode:
      return {
        kind: "unicode",
        text: Buffer.from(bytes).toString("utf16le"),
      };
    case TYPE.binary:
      return { kind: "binary", bytes };
    default:
      return { kind: "object", bytes };
  }
};

/**
 * A MAPI property list ([MS-OXTNEF] 2.1.3.4): `count` properties, each a
 * type, an id (a named property's GUID and name after it), and its values.
 * Only the first value of each property is kept.
 */
const readProperties = (cursor: Cursor, count: number): Properties => {
  const properties = new Map<number, PropertyValue>();
  if (count > TNEF_LIMITS.propertiesPerList) {
    cursor.fail(
      limit("A TNEF property list holds more properties than allowed"),
    );
    return properties;
  }
  for (let index = 0; index < count && !cursor.failed; index += 1) {
    const type = cursor.uint16();
    const id = cursor.uint16();
    if (id >= 0x80_00) {
      // A named property: its property set, then a number or a name.
      cursor.take(16);
      const kind = cursor.uint32();
      if (kind === 0) {
        cursor.uint32();
      } else if (kind === 1) {
        variableValue(cursor);
      } else {
        cursor.fail(invalid("A TNEF named property has an unknown kind"));
        break;
      }
    }
    const multiple = Math.floor(type / TYPE.multiple) % 2 === 1;
    const base = type % TYPE.multiple;
    if (!FIXED_SIZES.has(base) && !VARIABLE_TYPES.has(base)) {
      cursor.fail(invalid("A TNEF property has an unknown type"));
      break;
    }
    const values = multiple || VARIABLE_TYPES.has(base) ? cursor.uint32() : 1;
    if (values > TNEF_LIMITS.valuesPerProperty) {
      cursor.fail(limit("A TNEF property holds more values than allowed"));
      break;
    }
    for (let value = 0; value < values && !cursor.failed; value += 1) {
      const read = readValue(cursor, base);
      if (value === 0 && !multiple && !properties.has(id)) {
        properties.set(id, read);
      }
    }
  }
  return properties;
};

const stringOf = (
  properties: Properties,
  id: number,
  codePage: number,
): string | null => {
  const value = properties.get(id);
  if (value?.kind === "unicode") {
    return cleanString(value.text);
  }
  if (value?.kind === "string8") {
    return cleanString(decodeString8(value.bytes, codePage));
  }
  return null;
};

const int32Of = (properties: Properties, id: number): number | null => {
  const value = properties.get(id);
  return value?.kind === "int32" ? value.value : null;
};

const timeOf = (properties: Properties, id: number): string | null => {
  const value = properties.get(id);
  return value?.kind === "time" ? value.value : null;
};

const binaryOf = (properties: Properties, id: number): Uint8Array | null => {
  const value = properties.get(id);
  return value?.kind === "binary" ? value.bytes : null;
};

/** A legacy string attribute: NUL-terminated, in the stream's code page. */
const legacyString = (data: Uint8Array, codePage: number): string | null =>
  cleanString(decodeString8(data, codePage));

/**
 * `attDateSent`: seven 16-bit fields (year, month, day, hour, minute,
 * second, weekday), a time without a zone, read as UTC.
 */
const legacyDate = (data: Uint8Array): string | null => {
  if (data.byteLength < 12) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const field = (index: number) => view.getUint16(index * 2, true);
  return Result.try(
    () =>
      Temporal.PlainDateTime.from(
        {
          year: field(0),
          month: field(1),
          day: field(2),
          hour: field(3),
          minute: field(4),
          second: field(5),
        },
        { overflow: "reject" },
      ).toZonedDateTime("UTC").epochMilliseconds,
  )
    .map((epochMs) => new Date(epochMs).toUTCString())
    .unwrapOr(null);
};

/** An address as an email address; an Exchange address is none. */
const smtpAddress = (address: string | null): string | null => {
  if (address?.toUpperCase().startsWith("SMTP:") === true) {
    return address.slice(5);
  }
  return address?.includes("@") === true ? address : null;
};

/**
 * `attFrom`: a TRP structure (type, size, name length, address length),
 * then the name and the address, each NUL-terminated.
 */
const legacySender = (data: Uint8Array, codePage: number) => {
  // A sender that does not read is no sender, never a failed message.
  const cursor = new Cursor(data, { error: null });
  cursor.uint16();
  cursor.uint16();
  const nameLength = cursor.uint16();
  const addressLength = cursor.uint16();
  const name = legacyString(cursor.take(nameLength), codePage);
  const address = legacyString(cursor.take(addressLength), codePage);
  if (cursor.failed) {
    return null;
  }
  return { name, email: smtpAddress(address) };
};

const recipientType = (value: number | null): TnefRecipient["type"] => {
  if (value === 2) {
    return "cc";
  }
  return value === 3 ? "bcc" : "to";
};

const readRecipients = (cursor: Cursor, codePage: number) => {
  const rows = cursor.uint32();
  const recipients: TnefRecipient[] = [];
  if (rows > TNEF_LIMITS.recipients) {
    cursor.fail(limit("A TNEF recipient table holds more rows than allowed"));
    return recipients;
  }
  for (let row = 0; row < rows && !cursor.failed; row += 1) {
    const properties = readProperties(cursor, cursor.uint32());
    recipients.push({
      name: stringOf(properties, PROPERTY.displayName, codePage),
      email:
        stringOf(properties, PROPERTY.smtpAddress, codePage) ??
        stringOf(properties, PROPERTY.emailAddress, codePage),
      type: recipientType(int32Of(properties, PROPERTY.recipientType)),
    });
  }
  return recipients;
};

type AttachmentDraft = {
  title: string | null;
  data: Uint8Array | null;
  properties: Properties;
};

const startsWith = (bytes: Uint8Array, prefix: Uint8Array) =>
  bytes.byteLength >= prefix.byteLength &&
  prefix.every((byte, index) => bytes[index] === byte);

const finishAttachment = (
  { title, data, properties }: AttachmentDraft,
  codePage: number,
): TnefAttachment | null => {
  const name =
    stringOf(properties, PROPERTY.attachLongFilename, codePage) ??
    stringOf(properties, PROPERTY.attachFilename, codePage) ??
    title ??
    stringOf(properties, PROPERTY.displayName, codePage);
  const object = properties.get(PROPERTY.attachData);
  const embedded =
    int32Of(properties, PROPERTY.attachMethod) === ATTACH_EMBEDDED_MESSAGE &&
    object?.kind === "object" &&
    startsWith(object.bytes, IID_IMESSAGE);
  const common = {
    mimeType: stringOf(properties, PROPERTY.attachMimeTag, codePage),
    contentId: stringOf(properties, PROPERTY.attachContentId, codePage),
    hidden: (int32Of(properties, PROPERTY.attachmentHidden) ?? 0) !== 0,
  };
  if (embedded) {
    return {
      ...common,
      fileName:
        name ?? stringOf(properties, PROPERTY.displayName, codePage) ?? null,
      bytes: object.bytes.subarray(IID_BYTES),
      message: true,
    };
  }
  const bytes = binaryOf(properties, PROPERTY.attachData) ?? data;
  return bytes === null
    ? null
    : { ...common, fileName: name, bytes, message: false };
};

/** What the message attributes say, as the stream is read. */
type MessageState = {
  codePage: number;
  properties: Properties;
  recipients: TnefRecipient[];
  subject: string | null;
  from: ReturnType<typeof legacySender>;
  date: string | null;
  body: string | null;
  messageClass: string | null;
};

const readMessageAttribute = (
  state: MessageState,
  id: number,
  data: Uint8Array,
  cursor: Cursor,
) => {
  switch (id) {
    case ATTRIBUTE.oemCodepage:
      if (data.byteLength >= 4) {
        state.codePage = cursor.over(data).uint32();
      }
      break;
    case ATTRIBUTE.subject:
      state.subject = legacyString(data, state.codePage);
      break;
    case ATTRIBUTE.messageClass:
      state.messageClass = legacyString(data, state.codePage);
      break;
    case ATTRIBUTE.body:
      state.body = legacyString(data, state.codePage);
      break;
    case ATTRIBUTE.dateSent:
      state.date = legacyDate(data);
      break;
    case ATTRIBUTE.from:
      state.from = legacySender(data, state.codePage);
      break;
    case ATTRIBUTE.msgProps: {
      const list = cursor.over(data);
      state.properties = readProperties(list, list.uint32());
      break;
    }
    case ATTRIBUTE.recipTable:
      state.recipients = readRecipients(cursor.over(data), state.codePage);
      break;
    default:
      break;
  }
};

const readAttachmentAttribute = (
  drafts: AttachmentDraft[],
  { id, data, codePage }: { id: number; data: Uint8Array; codePage: number },
  cursor: Cursor,
) => {
  if (id === ATTRIBUTE.attachRendData) {
    if (drafts.length >= TNEF_LIMITS.attachments) {
      cursor.fail(limit("The TNEF stream holds more attachments than allowed"));
      return;
    }
    drafts.push({ title: null, data: null, properties: new Map() });
    return;
  }
  const draft = drafts.at(-1);
  if (draft === undefined) {
    cursor.fail(
      invalid("A TNEF attachment attribute comes before its attachment"),
    );
    return;
  }
  if (id === ATTRIBUTE.attachTitle) {
    draft.title = legacyString(data, codePage);
  } else if (id === ATTRIBUTE.attachData) {
    draft.data = data;
  } else if (id === ATTRIBUTE.attachment) {
    const list = cursor.over(data);
    draft.properties = readProperties(list, list.uint32());
  }
};

const messageOf = (
  state: MessageState,
  drafts: readonly AttachmentDraft[],
): TnefMessage => {
  const { codePage, properties } = state;
  const string = (id: number) => stringOf(properties, id, codePage);
  const internetCodePage =
    int32Of(properties, PROPERTY.internetCodepage) ?? codePage;
  const rtfStream = binaryOf(properties, PROPERTY.rtfCompressed);
  const htmlBinary = binaryOf(properties, PROPERTY.bodyHtml);
  return {
    messageClass: state.messageClass ?? string(PROPERTY.messageClass),
    subject: string(PROPERTY.subject) ?? state.subject,
    fromName:
      string(PROPERTY.senderName) ??
      string(PROPERTY.sentRepresentingName) ??
      state.from?.name ??
      null,
    fromEmail:
      string(PROPERTY.senderSmtpAddress) ??
      string(PROPERTY.sentRepresentingEmail) ??
      string(PROPERTY.senderEmail) ??
      state.from?.email ??
      null,
    recipients: state.recipients,
    date:
      timeOf(properties, PROPERTY.clientSubmitTime) ??
      timeOf(properties, PROPERTY.deliveryTime) ??
      state.date,
    html:
      stringOf(properties, PROPERTY.bodyHtml, internetCodePage) ??
      (htmlBinary === null
        ? null
        : cleanString(decodeString8(htmlBinary, internetCodePage))),
    rtf:
      rtfStream === null
        ? null
        : decompressRtf(rtfStream, { maxBytes: TNEF_LIMITS.rtfBytes }).unwrapOr(
            null,
          ),
    text: string(PROPERTY.body) ?? state.body,
    attachments: drafts.flatMap((draft) => {
      const attachment = finishAttachment(draft, codePage);
      return attachment === null ? [] : [attachment];
    }),
  };
};

const parse = (bytes: Uint8Array): Result<TnefMessage, TnefParseError> => {
  if (!hasTnefSignature(bytes)) {
    return Result.err(invalid("The file is not a TNEF stream"));
  }
  const failure: Failure = { error: null };
  const cursor = new Cursor(bytes, failure);
  cursor.uint32();
  cursor.uint16();
  const state: MessageState = {
    codePage: 1252,
    properties: new Map(),
    recipients: [],
    subject: null,
    from: null,
    date: null,
    body: null,
    messageClass: null,
  };
  const drafts: AttachmentDraft[] = [];
  let attributes = 0;
  while (cursor.remaining > 0 && !cursor.failed) {
    attributes += 1;
    if (attributes > TNEF_LIMITS.attributes) {
      cursor.fail(limit("The TNEF stream holds more attributes than allowed"));
      break;
    }
    const level = cursor.uint8();
    const id = cursor.uint32() % 0x1_00_00;
    const data = cursor.take(cursor.uint32());
    // The checksum is not checked: writers differ in what they sum.
    cursor.uint16();
    if (level === LEVEL_MESSAGE) {
      readMessageAttribute(state, id, data, cursor);
    } else if (level === LEVEL_ATTACHMENT) {
      readAttachmentAttribute(
        drafts,
        { id, data, codePage: state.codePage },
        cursor,
      );
    } else {
      cursor.fail(invalid("A TNEF attribute has an unknown level"));
    }
  }
  return failure.error === null
    ? Result.ok(messageOf(state, drafts))
    : Result.err(failure.error);
};

/** The message a TNEF stream carries. */
export const parseTnef = (
  bytes: Uint8Array,
): Result<TnefMessage, TnefParseError> =>
  Result.try({
    try: () => parse(bytes),
    catch: () => invalid("The TNEF stream could not be read"),
  }).andThen((parsed) => parsed);
