import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  createPstReader,
  type PstHostFile,
  pstInteger,
  type PstListing,
  type PstMailbox,
  type PstMessage,
  pstProperty,
  type PstRead,
  type PstReaderLimits,
  pstTime,
} from "./pst-reader";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

const LIMITS: PstReaderLimits = {
  maxMessages: 10_000,
  maxMessageBytes: 32 * 1024 * 1024,
  maxWalkBytes: 128 * 1024 * 1024,
  maxMessageReadBytes: 96 * 1024 * 1024,
  maxReads: 1_000_000,
  maxFolders: 2000,
  maxFolderDepth: 32,
  maxRecipients: 500,
  maxAttachments: 100,
};

const inMemory = (bytes: Uint8Array): PstHostFile => ({
  size: bytes.byteLength,
  readAt: (offset, buffer) => {
    const read = bytes.subarray(offset, offset + buffer.byteLength);
    buffer.set(read);
    return read.byteLength;
  },
});

const reader = createPstReader();

const read = <T>(result: PstRead<T>): T => {
  if (result.type !== "read") {
    throw new Error(`Expected a read, got ${result.type}`);
  }
  return result.value;
};

const open = (bytes: Uint8Array, limits = LIMITS): PstMailbox =>
  read(reader.open(inMemory(bytes), limits));

const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

const SUBJECT = 0x00_37;
const DISPLAY_NAME = 0x30_01;
const DELIVERY_TIME = 0x0e_06;
const MESSAGE_SIZE = 0x0e_08;
const ATTACH_LONG_FILENAME = 0x37_07;

const folderPath = (listing: PstListing, index: number): string => {
  const names: string[] = [];
  for (
    let folder = listing.folders[index];
    folder !== undefined;
    folder = folder.parent === null ? undefined : listing.folders[folder.parent]
  ) {
    if (folder.depth > 0) {
      names.unshift(
        text(pstProperty(folder.properties, DISPLAY_NAME)?.bytes) ?? "",
      );
    }
  }
  return names.join("/");
};

describe("createPstReader", () => {
  test("lists the folders and messages of a mailbox", () => {
    const listing = read(open(fixture("law-firm.pst")).list());
    expect(
      listing.messages.map((message) => [
        folderPath(listing, message.folder),
        text(pstProperty(message.properties, SUBJECT)?.bytes) ?? null,
      ]),
    ).toEqual([
      ["Doručená pošta", "Smlouva o převodu podílu: návrh k připomínkám"],
      ["Doručená pošta", "Re: Termín jednání"],
      ["Doručená pošta", null],
      ["Doručená pošta", "Zápis z porady"],
      ["Doručená pošta", "Plná moc"],
      ["Doručená pošta/Klienti/Fiktivní stavby", "Fwd: Výzva k úhradě"],
      ["Doručená pošta/Klienti/Fiktivní stavby", "Spis ve skenech"],
      ["Odeslaná pošta", "Ελληνικά, العربية, 日本語"],
      ["Archiv/2023", "Uzavření věci"],
    ]);
    expect(listing.truncated).toBe(false);
    const [first] = listing.messages;
    expect(pstTime(first?.properties ?? [], DELIVERY_TIME)?.toISOString()).toBe(
      "2024-03-04T09:01:00.000Z",
    );
    expect(
      pstInteger(listing.messages[6]?.properties ?? [], MESSAGE_SIZE),
    ).toBe(48 * 1024 * 1024);
  });

  test("reads one message with its attachments", () => {
    const message: PstMessage = read(open(fixture("law-firm.pst")).message(0));
    expect(
      message.attachments.map((attachment) => [
        text(pstProperty(attachment.properties, ATTACH_LONG_FILENAME)?.bytes),
        attachment.content instanceof Uint8Array
          ? attachment.content.byteLength
          : null,
      ]),
    ).toEqual([
      ["navrh-smlouvy.pdf", expect.any(Number)],
      ["poznámky k návrhu.txt", 75],
    ]);
    expect(message.recipients).toHaveLength(2);
    expect(message.attachmentsTruncated).toBe(false);
  });

  test("refuses what it does not read", () => {
    const mailbox = open(fixture("law-firm.pst"));
    expect(mailbox.message(6)).toEqual({ type: "too-large" });
    expect(mailbox.message(9)).toEqual({ type: "no-message" });
    expect(reader.open(inMemory(new Uint8Array(4096)), LIMITS)).toEqual({
      type: "unreadable",
    });
    expect(
      reader.open(inMemory(fixture("law-firm.pst").subarray(0, 600)), LIMITS),
    ).toEqual({ type: "unreadable" });
  });

  test("lists at most its message bound and says so", () => {
    const listing = read(
      open(fixture("law-firm.pst"), { ...LIMITS, maxMessages: 3 }).list(),
    );
    expect(listing.messages).toHaveLength(3);
    expect(listing.truncated).toBe(true);
  });

  test("stops when the file stops it", () => {
    const bytes = fixture("law-firm.pst");
    const state = { reads: 0 };
    const stopping: PstHostFile = {
      size: bytes.byteLength,
      readAt: (offset, buffer) => {
        state.reads += 1;
        return state.reads > 2 ? -1 : inMemory(bytes).readAt(offset, buffer);
      },
    };
    expect(reader.open(stopping, LIMITS)).toEqual({ type: "exhausted" });
  });

  test("the library's empty mailbox lists nothing", () => {
    const listing = read(open(fixture("outlook-pst-rs/Empty.pst")).list());
    expect(listing.messages).toEqual([]);
    expect(listing.truncated).toBe(false);
  });

  test("refuses limits that are not positive whole numbers", () => {
    expect(() =>
      reader.open(inMemory(fixture("law-firm.pst")), {
        ...LIMITS,
        maxMessages: 0.5,
      }),
    ).toThrow("limits must be positive integers");
  });

  test("a closed mailbox's memory is released", () => {
    const mailbox = open(fixture("law-firm.pst"));
    read(mailbox.list());
    mailbox.close();
    expect(read(open(fixture("law-firm.pst")).list()).messages).toHaveLength(9);
  });
});
