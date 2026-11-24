import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PST_PROPERTY_TYPE,
  type PstMessage,
  type PstProperty,
} from "@stll/pst-reader";

/**
 * A PST fixture of `@stll/pst-reader` (see its `fixtures/README.md`):
 * `law-firm.pst`, invented correspondence of an invented law firm written by
 * the package's PST assembler, or `outlook-pst-rs/Empty.pst`, the reader
 * library's own empty mailbox.
 */
export const pstFixture = (
  name: "law-firm.pst" | "outlook-pst-rs/Empty.pst",
): Uint8Array =>
  new Uint8Array(
    readFileSync(
      fileURLToPath(import.meta.resolve(`@stll/pst-reader/fixtures/${name}`)),
    ),
  );

/**
 * The law firm mailbox's messages in list order: folder, subject, file name.
 * The fixture's source is `fixtures::law_firm` in the package.
 */
export const LAW_FIRM_MESSAGES = [
  {
    folder: "Doručená pošta",
    subject: "Smlouva o převodu podílu: návrh k připomínkám",
    fileName: "Smlouva o převodu podílu_ návrh k připomínkám.eml",
  },
  {
    folder: "Doručená pošta",
    subject: "Re: Termín jednání",
    fileName: "Re_ Termín jednání.eml",
  },
  {
    folder: "Doručená pošta",
    subject: null,
    fileName: "korespondence-3.eml",
  },
  {
    folder: "Doručená pošta",
    subject: "Zápis z porady",
    fileName: "Zápis z porady.eml",
  },
  { folder: "Doručená pošta", subject: "Plná moc", fileName: "Plná moc.eml" },
  {
    folder: "Doručená pošta/Klienti/Fiktivní stavby",
    subject: "Fwd: Výzva k úhradě",
    fileName: "Fwd_ Výzva k úhradě.eml",
  },
  {
    folder: "Doručená pošta/Klienti/Fiktivní stavby",
    subject: "Spis ve skenech",
    fileName: "Spis ve skenech.eml",
  },
  {
    folder: "Odeslaná pošta",
    subject: "Ελληνικά, العربية, 日本語",
    fileName: "Ελληνικά, العربية, 日本語.eml",
  },
  { folder: "Archiv/2023", subject: "Uzavření věci", fileName: "Uzavření věci.eml" },
] as const;

/** The name the law firm mailbox is stored under in the tests. */
export const LAW_FIRM_MAILBOX_NAME = "korespondence.pst";

const encoder = new TextEncoder();

/** MAPI properties as the reader hands them on. */
export const pstProperties = {
  unicode: (id: number, text: string): PstProperty => ({
    id,
    type: PST_PROPERTY_TYPE.unicode,
    bytes: encoder.encode(text),
  }),
  string8: (id: number, bytes: Uint8Array): PstProperty => ({
    id,
    type: PST_PROPERTY_TYPE.string8,
    bytes,
  }),
  integer32: (id: number, value: number): PstProperty => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value, true);
    return { id, type: PST_PROPERTY_TYPE.integer32, bytes };
  },
  boolean: (id: number, value: boolean): PstProperty => ({
    id,
    type: PST_PROPERTY_TYPE.boolean,
    bytes: Uint8Array.of(value ? 1 : 0),
  }),
  time: (id: number, date: Date): PstProperty => {
    const bytes = new Uint8Array(8);
    const ticks = BigInt(date.getTime()) * 10_000n + 116_444_736_000_000_000n;
    new DataView(bytes.buffer).setBigInt64(0, ticks, true);
    return { id, type: PST_PROPERTY_TYPE.time, bytes };
  },
  binary: (id: number, bytes: Uint8Array): PstProperty => ({
    id,
    type: PST_PROPERTY_TYPE.binary,
    bytes,
  }),
};

/** A message as the reader gives it, with no recipients or attachments. */
export const pstMessage = (
  properties: PstProperty[],
  more: Partial<Omit<PstMessage, "properties">> = {},
): PstMessage => ({
  properties,
  recipients: [],
  attachments: [],
  attachmentsTruncated: false,
  ...more,
});

/** An RTF body as `PidTagRtfCompressed` stores it uncompressed (`MELA`). */
export const uncompressedRtf = (rtf: string): Uint8Array => {
  const raw = encoder.encode(rtf);
  const bytes = new Uint8Array(raw.byteLength + 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, raw.byteLength + 12, true);
  view.setUint32(4, raw.byteLength, true);
  view.setUint32(8, 0x41_4c_45_4d, true);
  view.setUint32(12, 0, true);
  bytes.set(raw, 16);
  return bytes;
};
