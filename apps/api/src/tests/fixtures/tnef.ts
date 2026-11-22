/**
 * Synthetic TNEF streams ([MS-OXTNEF]) as Outlook writes them: the legacy
 * message attributes, the MAPI properties in `attMsgProps`, a recipient
 * table, and attachments with both their legacy attributes and their MAPI
 * properties. Every name, address and document is invented.
 */
import { PDF, StandardFonts } from "@libpdf/core";

import {
  COMPRESSED_RTF_PREBUFFER,
  compressedRtfCrc,
} from "@/api/lib/files/rtf-compressed";

const LEVEL_MESSAGE = 1;
const LEVEL_ATTACHMENT = 2;

/** Attribute ids with their types in the high word ([MS-OXTNEF] 2.1.3.2). */
const ATTRIBUTE = {
  tnefVersion: 0x00_08_90_06,
  oemCodepage: 0x00_06_90_07,
  messageClass: 0x00_07_80_08,
  subject: 0x00_01_80_04,
  dateSent: 0x00_03_80_05,
  msgProps: 0x00_06_90_03,
  recipTable: 0x00_06_90_04,
  attachRendData: 0x00_06_90_02,
  attachTitle: 0x00_01_80_10,
  attachData: 0x00_06_80_0f,
  attachment: 0x00_06_90_05,
} as const;

const IID_IMESSAGE = [
  0x07, 0x03, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x46,
];

const concat = (parts: readonly Uint8Array[]) =>
  new Uint8Array(Buffer.concat(parts));

const u16 = (value: number) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
};

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

const padded = (bytes: Uint8Array) =>
  concat([bytes, new Uint8Array((4 - (bytes.byteLength % 4)) % 4)]);

const utf16 = (text: string) =>
  new Uint8Array(Buffer.from(`${text}\u0000`, "utf16le"));

/** A legacy string attribute's data: the text and a NUL, in Windows-1252. */
const legacyString = (text: string) =>
  concat([new TextEncoder().encode(text), new Uint8Array([0])]);

const checksum = (data: Uint8Array) =>
  data.reduce((sum, byte) => (sum + byte) % 65_536, 0);

/** One attribute: level, id, length, data and the data's checksum. */
export const tnefAttribute = (level: number, id: number, data: Uint8Array) =>
  concat([
    new Uint8Array([level]),
    u32(id),
    u32(data.byteLength),
    data,
    u16(checksum(data)),
  ]);

type Property = { type: number; id: number; value: Uint8Array };

const variable = (type: number, id: number, bytes: Uint8Array): Property => ({
  type,
  id,
  value: concat([u32(1), u32(bytes.byteLength), padded(bytes)]),
});

export const mapi = {
  unicode: (id: number, text: string) => variable(0x00_1f, id, utf16(text)),
  string8: (id: number, text: string) =>
    variable(0x00_1e, id, legacyString(text)),
  binary: (id: number, bytes: Uint8Array) => variable(0x01_02, id, bytes),
  object: (id: number, bytes: Uint8Array) => variable(0x00_0d, id, bytes),
  int32: (id: number, value: number): Property => ({
    type: 0x00_03,
    id,
    value: u32(value),
  }),
  boolean: (id: number, value: boolean): Property => ({
    type: 0x00_0b,
    id,
    value: concat([u16(value ? 1 : 0), u16(0)]),
  }),
  time: (id: number, date: Date): Property => {
    const ticks =
      (BigInt(date.getTime()) + 11_644_473_600_000n) * 10_000n;
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, ticks, true);
    return { type: 0x00_40, id, value: bytes };
  },
  /** A named property in PSETID_Common, by its long id. */
  namedInt32: (lid: number, value: number): Property => ({
    type: 0x00_03,
    id: 0x80_00,
    value: concat([
      new Uint8Array([
        0x08, 0x20, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x46,
      ]),
      u32(0),
      u32(lid),
      u32(value),
    ]),
  }),
};

/** A property list: its count, then each property's type, id and value. */
export const propertyList = (properties: readonly Property[]) =>
  concat([
    u32(properties.length),
    ...properties.flatMap(({ type, id, value }) => [u16(type), u16(id), value]),
  ]);

/** `attDateSent`: year, month, day, hour, minute, second, weekday. */
const dateTime = (date: Date) =>
  concat(
    [
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCDay(),
    ].map(u16),
  );

const DICTIONARY_BYTES = 4096;
const MAX_MATCH = 17;

/**
 * Compressed RTF ([MS-OXRTFCP] 2.2) with the specification's longest-match
 * search over the 4096-byte dictionary, references never reading bytes the
 * same reference writes.
 */
export const compressRtf = (rtf: Uint8Array): Uint8Array => {
  const dictionary = new Uint8Array(DICTIONARY_BYTES);
  dictionary.set(COMPRESSED_RTF_PREBUFFER);
  let write = COMPRESSED_RTF_PREBUFFER.byteLength;
  const content: number[] = [];
  let controlAt = -1;
  let tokens = 8;
  const token = (bytes: number[], reference: boolean) => {
    if (tokens === 8) {
      controlAt = content.length;
      content.push(0);
      tokens = 0;
    }
    if (reference) {
      content[controlAt] = (content[controlAt] ?? 0) + 2 ** tokens;
    }
    content.push(...bytes);
    tokens += 1;
  };
  const put = (byte: number) => {
    dictionary[write] = byte;
    write = (write + 1) % DICTIONARY_BYTES;
  };
  let at = 0;
  while (at < rtf.byteLength) {
    let best = 0;
    let bestOffset = 0;
    for (let offset = 0; offset < DICTIONARY_BYTES; offset += 1) {
      if (offset === write) {
        continue;
      }
      let length = 0;
      while (
        length < MAX_MATCH &&
        at + length < rtf.byteLength &&
        // Never read a byte this reference itself writes.
        (offset + length - write + DICTIONARY_BYTES) % DICTIONARY_BYTES >=
          length + 1 &&
        dictionary[(offset + length) % DICTIONARY_BYTES] === rtf[at + length]
      ) {
        length += 1;
      }
      if (length > best) {
        best = length;
        bestOffset = offset;
      }
    }
    if (best >= 2) {
      const reference = bestOffset * 16 + (best - 2);
      token([Math.floor(reference / 256), reference % 256], true);
      for (let index = 0; index < best; index += 1) {
        put(rtf[at + index] ?? 0);
      }
      at += best;
    } else {
      const byte = rtf[at] ?? 0;
      token([byte], false);
      put(byte);
      at += 1;
    }
  }
  const end = write * 16;
  token([Math.floor(end / 256), end % 256], true);
  const body = new Uint8Array(content);
  return concat([
    u32(body.byteLength + 12),
    u32(rtf.byteLength),
    u32(0x75_46_5a_4c),
    u32(compressedRtfCrc(body)),
    body,
  ]);
};

export type TnefFixtureAttachment = {
  /** The long name in `PidTagAttachLongFilename`. */
  readonly fileName: string;
  /** The legacy 8.3 title (`attAttachTitle`); the long name when absent. */
  readonly title?: string;
  readonly mimeType?: string;
  readonly contentId?: string;
  readonly hidden?: boolean;
  readonly bytes: Uint8Array;
  /** Only the legacy attributes, no MAPI properties, as old writers send. */
  readonly legacyOnly?: boolean;
};

export type TnefFixture = {
  readonly subject: string;
  readonly from: { readonly name: string; readonly email: string };
  readonly to: readonly { readonly name: string; readonly email: string }[];
  readonly cc?: readonly { readonly name: string; readonly email: string }[];
  readonly sentAt: Date;
  readonly body: {
    readonly html?: string;
    readonly rtf?: string;
    readonly text?: string;
  };
  readonly attachments: readonly TnefFixtureAttachment[];
  /** A message attached whole: its display name and its TNEF stream. */
  readonly attachedMessage?: { readonly name: string; readonly tnef: Uint8Array };
};

const recipientRow = (
  { name, email }: { name: string; email: string },
  type: number,
) =>
  propertyList([
    mapi.unicode(0x30_01, name),
    mapi.string8(0x30_02, "SMTP"),
    mapi.unicode(0x30_03, email),
    mapi.unicode(0x39_fe, email),
    mapi.int32(0x0c_15, type),
  ]);

/** Rendering data that starts an attachment: a file at no position. */
const RENDERING = concat([
  u16(1),
  u32(0xff_ff_ff_ff),
  u16(0xff_ff),
  u16(0xff_ff),
  u32(0),
]);

/** A TNEF stream for one message, as `winmail.dat` carries it. */
export const tnefStream = (fixture: TnefFixture): Uint8Array => {
  const message = (id: number, data: Uint8Array) =>
    tnefAttribute(LEVEL_MESSAGE, id, data);
  const attachment = (id: number, data: Uint8Array) =>
    tnefAttribute(LEVEL_ATTACHMENT, id, data);
  const recipients = [
    ...fixture.to.map((recipient) => recipientRow(recipient, 1)),
    ...(fixture.cc ?? []).map((recipient) => recipientRow(recipient, 2)),
  ];
  const { html, rtf, text } = fixture.body;
  const properties = [
    mapi.unicode(0x00_37, fixture.subject),
    mapi.unicode(0x0c_1a, fixture.from.name),
    mapi.unicode(0x5d_01, fixture.from.email),
    mapi.time(0x00_39, fixture.sentAt),
    mapi.int32(0x3f_de, 65_001),
    mapi.namedInt32(0x85_80, 1),
    ...(text === undefined ? [] : [mapi.unicode(0x10_00, text)]),
    ...(html === undefined
      ? []
      : [mapi.binary(0x10_13, new TextEncoder().encode(html))]),
    ...(rtf === undefined
      ? []
      : [mapi.binary(0x10_09, compressRtf(new TextEncoder().encode(rtf)))]),
  ];
  return concat([
    u32(0x22_3e_9f_78),
    u16(0x01_00),
    message(ATTRIBUTE.tnefVersion, u32(0x00_01_00_00)),
    message(ATTRIBUTE.oemCodepage, concat([u32(1252), u32(0)])),
    message(ATTRIBUTE.messageClass, legacyString("IPM.Microsoft Mail.Note")),
    message(ATTRIBUTE.subject, legacyString(fixture.subject)),
    message(ATTRIBUTE.dateSent, dateTime(fixture.sentAt)),
    message(ATTRIBUTE.msgProps, propertyList(properties)),
    message(
      ATTRIBUTE.recipTable,
      concat([u32(recipients.length), ...recipients]),
    ),
    ...fixture.attachments.flatMap((file) => [
      attachment(ATTRIBUTE.attachRendData, RENDERING),
      attachment(
        ATTRIBUTE.attachTitle,
        legacyString(file.title ?? file.fileName),
      ),
      attachment(ATTRIBUTE.attachData, file.bytes),
      ...(file.legacyOnly === true
        ? []
        : [
            attachment(
              ATTRIBUTE.attachment,
              propertyList([
                mapi.unicode(0x37_07, file.fileName),
                mapi.int32(0x37_05, 1),
                ...(file.mimeType === undefined
                  ? []
                  : [mapi.string8(0x37_0e, file.mimeType)]),
                ...(file.contentId === undefined
                  ? []
                  : [mapi.unicode(0x37_12, file.contentId)]),
                ...(file.hidden === undefined
                  ? []
                  : [mapi.boolean(0x7f_fe, file.hidden)]),
              ]),
            ),
          ]),
    ]),
    ...(fixture.attachedMessage === undefined
      ? []
      : [
          attachment(ATTRIBUTE.attachRendData, RENDERING),
          attachment(
            ATTRIBUTE.attachTitle,
            legacyString(fixture.attachedMessage.name),
          ),
          attachment(
            ATTRIBUTE.attachment,
            propertyList([
              mapi.unicode(0x30_01, fixture.attachedMessage.name),
              mapi.int32(0x37_05, 5),
              mapi.object(
                0x37_01,
                concat([
                  new Uint8Array(IID_IMESSAGE),
                  fixture.attachedMessage.tnef,
                ]),
              ),
            ]),
          ),
        ]),
  ]);
};

const pdfBytes = async (text: string) => {
  const pdf = PDF.create();
  pdf.addPage({ width: 300, height: 200 }).drawText(text, {
    x: 20,
    y: 60,
    size: 14,
    font: StandardFonts.Helvetica,
  });
  return await pdf.save();
};

const EXHIBITS = new TextEncoder().encode(
  "Anlage B1: Bauvertrag vom 14.03.2025\nAnlage B2: Abnahmeprotokoll",
);

/**
 * A Munich firm's reply to a client, sent from Outlook as `winmail.dat`: an
 * HTML body in compressed RTF, a plain text body, a PDF draft and a list of
 * exhibits.
 */
export const wendlerMessage = async () => {
  const DRAFT = await pdfBytes("Klageerwiderung 3 O 214/26");
  const message = {
    subject: "Klageerwiderung Az. 3 O 214/26, Entwurf zur Abstimmung",
    from: {
      name: "Dr. Katharina Wendler",
      email: "k.wendler@wendler-rechtsanwaelte.de",
    },
    to: [{ name: "Jonas Pfeiffer", email: "j.pfeiffer@pfeiffer-hochbau.de" }],
    cc: [
      {
        name: "Lea Brandstetter",
        email: "l.brandstetter@wendler-rechtsanwaelte.de",
      },
    ],
    sentAt: new Date("2026-11-17T08:42:00Z"),
    body: {
      rtf: [
        "{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}",
        "{\\*\\htmltag19 <html><body>}",
        "{\\*\\htmltag64 <p>}Sehr geehrter Herr Pfeiffer,{\\*\\htmltag72 </p>}",
        "\\htmlrtf \\par \\htmlrtf0 ",
        "{\\*\\htmltag64 <p>}anbei der Entwurf der Klageerwiderung f\\'fcr die m\\'fcndliche Verhandlung am 9. Dezember.",
        "{\\*\\htmltag72 </p>}{\\*\\htmltag27 </body></html>}}",
      ].join("\r\n"),
      text: "Sehr geehrter Herr Pfeiffer,\r\nanbei der Entwurf der Klageerwiderung.",
    },
    attachments: [
      {
        fileName: "Klageerwiderung_Entwurf_3_O_214-26.pdf",
        title: "KLAGEE~1.PDF",
        mimeType: "application/pdf",
        bytes: DRAFT,
      },
      {
        fileName: "Anlagenverzeichnis Pfeiffer Hochbau GmbH.txt",
        title: "ANLAGE~1.TXT",
        mimeType: "text/plain",
        bytes: EXHIBITS,
      },
    ],
  } satisfies TnefFixture;
  return { message, draft: DRAFT, exhibits: EXHIBITS };
};

