/**
 * The reader's output (`src/wire.rs`): a mailbox's folders and messages, and
 * one message's properties, recipients and attachments, as MAPI properties.
 * Decoding checks every length against the bytes left, so output that does
 * not decode is refused whole, never read in part.
 */

/** MAPI property types the reader hands on ([MS-OXCDATA] 2.11.1). */
export const PST_PROPERTY_TYPE = {
  integer16: 0x00_02,
  integer32: 0x00_03,
  boolean: 0x00_0b,
  integer64: 0x00_14,
  string8: 0x00_1e,
  unicode: 0x00_1f,
  time: 0x00_40,
  binary: 0x01_02,
} as const;

/** One MAPI property: its id, its type and its value's bytes. */
export type PstProperty = {
  readonly id: number;
  readonly type: number;
  readonly bytes: Uint8Array;
};

export type PstFolder = {
  /** The parent folder's index in the listing; null for the top folder. */
  readonly parent: number | null;
  /** How deep below the top folder it is; the top folder is 0. */
  readonly depth: number;
  readonly properties: readonly PstProperty[];
};

/** A message as its folder's contents table lists it. */
export type PstListedMessage = {
  /** Its folder's index in the listing. */
  readonly folder: number;
  readonly node: number;
  readonly properties: readonly PstProperty[];
};

export type PstListing = {
  readonly folders: readonly PstFolder[];
  readonly messages: readonly PstListedMessage[];
  /** The mailbox holds more than the listing gives. */
  readonly truncated: boolean;
};

export type PstAttachment = {
  readonly properties: readonly PstProperty[];
  /** Its bytes, an attached message, or null when its content is not read. */
  readonly content: Uint8Array | PstMessage | null;
};

export type PstMessage = {
  readonly properties: readonly PstProperty[];
  readonly recipients: readonly (readonly PstProperty[])[];
  readonly attachments: readonly PstAttachment[];
  /** The message has more attachments than it gives. */
  readonly attachmentsTruncated: boolean;
};

const LISTING_MAGIC = "PSTL";
const MESSAGE_MAGIC = "PSTM";
const WIRE_VERSION = 1;

/** How deep attached messages may nest in one message's output. */
const MAX_NESTING = 8;

class Cursor {
  private offset = 0;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  private need(count: number): boolean {
    return count >= 0 && this.offset + count <= this.bytes.byteLength;
  }

  u8(): number | null {
    if (!this.need(1)) {
      return null;
    }
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number | null {
    if (!this.need(2)) {
      return null;
    }
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number | null {
    if (!this.need(4)) {
      return null;
    }
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  take(count: number): Uint8Array | null {
    if (!this.need(count)) {
      return null;
    }
    const value = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }

  /** The magic (ASCII) and the wire version. */
  magic(expected: string): boolean {
    const read = this.take(expected.length);
    return (
      read !== null &&
      read.every((byte, index) => byte === expected.codePointAt(index)) &&
      this.u8() === WIRE_VERSION
    );
  }
}

const properties = (cursor: Cursor): PstProperty[] | null => {
  const count = cursor.u32();
  if (count === null) {
    return null;
  }
  const read: PstProperty[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = cursor.u16();
    const type = cursor.u16();
    const length = cursor.u32();
    const bytes = length === null ? null : cursor.take(length);
    if (id === null || type === null || bytes === null) {
      return null;
    }
    read.push({ id, type, bytes });
  }
  return read;
};

const ATTACHMENT_CONTENT = { none: 0, bytes: 1, message: 2 } as const;

const message = (cursor: Cursor, depth: number): PstMessage | null => {
  if (depth > MAX_NESTING) {
    return null;
  }
  const own = properties(cursor);
  const recipientCount = cursor.u32();
  if (own === null || recipientCount === null) {
    return null;
  }
  const recipients: PstProperty[][] = [];
  for (let index = 0; index < recipientCount; index += 1) {
    const recipient = properties(cursor);
    if (recipient === null) {
      return null;
    }
    recipients.push(recipient);
  }
  const attachmentCount = cursor.u32();
  if (attachmentCount === null) {
    return null;
  }
  const attachments: PstAttachment[] = [];
  for (let index = 0; index < attachmentCount; index += 1) {
    const attachment = properties(cursor);
    const kind = cursor.u8();
    if (attachment === null || kind === null) {
      return null;
    }
    let content: PstAttachment["content"];
    if (kind === ATTACHMENT_CONTENT.none) {
      content = null;
    } else if (kind === ATTACHMENT_CONTENT.bytes) {
      const length = cursor.u32();
      content = length === null ? null : cursor.take(length);
      if (content === null) {
        return null;
      }
    } else if (kind === ATTACHMENT_CONTENT.message) {
      content = message(cursor, depth + 1);
      if (content === null) {
        return null;
      }
    } else {
      return null;
    }
    attachments.push({ properties: attachment, content });
  }
  const truncated = cursor.u8();
  if (truncated === null || truncated > 1) {
    return null;
  }
  return {
    properties: own,
    recipients,
    attachments,
    attachmentsTruncated: truncated === 1,
  };
};

/** The reader's list, or null for output that does not decode. */
export const decodePstListing = (bytes: Uint8Array): PstListing | null => {
  const cursor = new Cursor(bytes);
  if (!cursor.magic(LISTING_MAGIC)) {
    return null;
  }
  const folderCount = cursor.u32();
  if (folderCount === null) {
    return null;
  }
  const folders: PstFolder[] = [];
  for (let index = 0; index < folderCount; index += 1) {
    const parent = cursor.u32();
    const depth = cursor.u32();
    const read = properties(cursor);
    if (parent === null || depth === null || read === null) {
      return null;
    }
    const parentIndex = parent === 0xff_ff_ff_ff ? null : parent;
    if (parentIndex !== null && parentIndex >= index) {
      return null;
    }
    folders.push({ parent: parentIndex, depth, properties: read });
  }
  const messageCount = cursor.u32();
  if (messageCount === null) {
    return null;
  }
  const messages: PstListedMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const folder = cursor.u32();
    const node = cursor.u32();
    const read = properties(cursor);
    if (
      folder === null ||
      node === null ||
      read === null ||
      folder >= folders.length
    ) {
      return null;
    }
    messages.push({ folder, node, properties: read });
  }
  const truncated = cursor.u8();
  return truncated === null || truncated > 1 || !cursor.done
    ? null
    : { folders, messages, truncated: truncated === 1 };
};

/** One message as the reader gives it, or null when it does not decode. */
export const decodePstMessage = (bytes: Uint8Array): PstMessage | null => {
  const cursor = new Cursor(bytes);
  if (!cursor.magic(MESSAGE_MAGIC)) {
    return null;
  }
  const read = message(cursor, 0);
  return read === null || !cursor.done ? null : read;
};

/** The first property with `id` among `found`. */
export const pstProperty = (
  found: readonly PstProperty[],
  id: number,
): PstProperty | undefined => found.find((property) => property.id === id);

/** A 32-bit integer property's value. */
export const pstInteger = (
  found: readonly PstProperty[],
  id: number,
): number | null => {
  const property = pstProperty(found, id);
  if (
    property?.type !== PST_PROPERTY_TYPE.integer32 ||
    property.bytes.byteLength !== 4
  ) {
    return null;
  }
  return new DataView(
    property.bytes.buffer,
    property.bytes.byteOffset,
    4,
  ).getInt32(0, true);
};

/** FILETIME ticks (100 ns) between 1601-01-01 and 1970-01-01. */
const FILETIME_UNIX_EPOCH_TICKS = 116_444_736_000_000_000;

/** A time property's value, or null when it is not a date one can show. */
export const pstTime = (
  found: readonly PstProperty[],
  id: number,
): Date | null => {
  const property = pstProperty(found, id);
  if (
    property?.type !== PST_PROPERTY_TYPE.time ||
    property.bytes.byteLength !== 8
  ) {
    return null;
  }
  const view = new DataView(
    property.bytes.buffer,
    property.bytes.byteOffset,
    8,
  );
  // As a float: below a microsecond of rounding for any date one shows.
  const ticks = view.getInt32(4, true) * 2 ** 32 + view.getUint32(0, true);
  const date = new Date(
    Math.round((ticks - FILETIME_UNIX_EPOCH_TICKS) / 10_000),
  );
  return Number.isNaN(date.getTime()) ? null : date;
};
