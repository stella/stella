/**
 * Bytes decoded as the charset they declare, in the order a browser honours:
 * a byte-order mark, then the HTTP `Content-Type` charset, then the
 * document's own declaration (`<?xml encoding>`, `<meta charset>`,
 * `<meta http-equiv="Content-Type">`) in its first kilobyte, then UTF-8.
 *
 * `Response.text()` and `Buffer.toString("utf-8")` ignore all of these and
 * always read UTF-8, so a page served in windows-1250 loses every non-ASCII
 * byte to U+FFFD before a parser sees it.
 */

import { Result } from "better-result";
// node:util's constructor takes any label string, which is what a charset
// read off the wire is; the global one is typed to a closed list of labels.
import { TextDecoder as LabelledTextDecoder } from "node:util";

export type DeclaredCharsetSource = "bom" | "http" | "document" | "default";

export type DeclaredText = {
  text: string;
  /** The WHATWG name of the charset the bytes were read as. */
  charset: string;
  source: DeclaredCharsetSource;
};

export type DecodeDeclaredOptions = {
  /** The response's `Content-Type` header, or null where there was none. */
  contentType: string | null;
};

/** How far into the document a declaration is looked for. */
const PRESCAN_BYTES = 1024;

const HTTP_CHARSET = /;\s*charset\s*=\s*"?(?<label>[^";\s]+)/iu;
const DOCUMENT_CHARSET = [
  /<\?xml[^>]*\bencoding\s*=\s*["'](?<label>[^"']+)["']/iu,
  /<meta[^>]*\bcharset\s*=\s*["']?(?<label>[^"'\s/>;]+)/iu,
];

const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], charset: "utf-8" },
  { bytes: [0xfe, 0xff], charset: "utf-16be" },
  { bytes: [0xff, 0xfe], charset: "utf-16le" },
] as const;

/** A decoder for a label the platform knows, or null. */
const decoderFor = (label: string): LabelledTextDecoder | null =>
  Result.try(
    () => new LabelledTextDecoder(label.trim().toLowerCase()),
  ).unwrapOr(null);

const bomCharset = (bytes: Uint8Array): string | null =>
  BOMS.find(({ bytes: bom }) =>
    bom.every((byte, index) => bytes[index] === byte),
  )?.charset ?? null;

const documentLabel = (bytes: Uint8Array): string | null => {
  // Every declaration is ASCII, and every charset a declaration can name
  // writes ASCII as ASCII, so a byte-per-character reading finds it.
  const head = String.fromCodePoint(...bytes.subarray(0, PRESCAN_BYTES));
  for (const pattern of DOCUMENT_CHARSET) {
    const label = pattern.exec(head)?.groups?.["label"];
    if (label !== undefined) {
      return label;
    }
  }
  return null;
};

export const decodeDeclared = (
  bytes: Uint8Array,
  { contentType }: DecodeDeclaredOptions,
): DeclaredText => {
  const bom = bomCharset(bytes);
  if (bom !== null) {
    // The platform decoders strip the BOM they were built for.
    return {
      text: new LabelledTextDecoder(bom).decode(bytes),
      charset: bom,
      source: "bom",
    };
  }
  const candidates: [DeclaredCharsetSource, string | null][] = [
    [
      "http",
      contentType === null
        ? null
        : (HTTP_CHARSET.exec(contentType)?.groups?.["label"] ?? null),
    ],
    ["document", documentLabel(bytes)],
  ];
  for (const [source, label] of candidates) {
    const decoder = label === null ? null : decoderFor(label);
    // A document that declares UTF-16 in ASCII bytes is not UTF-16; WHATWG
    // reads such a declaration as UTF-8, and so does this.
    if (decoder !== null && !decoder.encoding.startsWith("utf-16")) {
      return { text: decoder.decode(bytes), charset: decoder.encoding, source };
    }
  }
  return {
    text: new TextDecoder().decode(bytes),
    charset: "utf-8",
    source: "default",
  };
};
