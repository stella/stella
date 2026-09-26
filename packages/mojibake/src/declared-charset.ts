/**
 * Bytes decoded as the charset they declare, in the order a browser honours:
 * a byte-order mark, then the HTTP `Content-Type` charset, then the
 * document's own declaration (a UTF-16 `<?x` prefix, `<?xml encoding>`,
 * `<meta charset>`, `<meta http-equiv="Content-Type">`) in its first
 * kilobyte, then UTF-8.
 *
 * `Response.text()` and `Buffer.toString("utf-8")` ignore all of these and
 * always read UTF-8, so a page served in windows-1250 loses every non-ASCII
 * byte to U+FFFD before a parser sees it.
 */

import { panic, Result } from "better-result";
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

const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], charset: "utf-8" },
  { bytes: [0xfe, 0xff], charset: "utf-16be" },
  { bytes: [0xff, 0xfe], charset: "utf-16le" },
] as const;

/**
 * `<?x` in UTF-16 without a byte-order mark: the prescan's second step reads
 * the charset off how the first ASCII characters are laid out.
 */
const UTF16_XML_PREFIXES = [
  { bytes: [0x3c, 0x00, 0x3f, 0x00, 0x78, 0x00], charset: "utf-16le" },
  { bytes: [0x00, 0x3c, 0x00, 0x3f, 0x00, 0x78], charset: "utf-16be" },
] as const;

/** A decoder for a label the platform knows, or null. */
const decoderFor = (label: string): LabelledTextDecoder | null =>
  Result.try(
    () => new LabelledTextDecoder(label.trim().toLowerCase()),
  ).unwrapOr(null);

type BytePrefix = { bytes: readonly number[]; charset: string };

/** The charset of the first of `prefixes` the bytes start with, or null. */
const prefixCharset = (
  bytes: Uint8Array,
  prefixes: readonly BytePrefix[],
): string | null =>
  prefixes.find(({ bytes: prefix }) =>
    prefix.every((byte, index) => bytes[index] === byte),
  )?.charset ?? null;

const isSpace = (char: string | undefined): boolean =>
  char === "\t" ||
  char === "\n" ||
  char === "\f" ||
  char === "\r" ||
  char === " ";

const isAsciiLetter = (char: string | undefined): boolean =>
  char !== undefined && /^[A-Za-z]$/u.test(char);

/** Only ASCII capitals: the prescan does not fold any other byte. */
const asciiLower = (char: string): string =>
  char >= "A" && char <= "Z" ? char.toLowerCase() : char;

type AttributeRead =
  | { type: "attribute"; name: string; value: string; next: number }
  /** `next` is the `>` that closes the tag. */
  | { type: "end-of-tag"; next: number }
  | { type: "end-of-input" };

type ValueReadOptions = { head: string; start: number; name: string };

const readAttributeValue = ({
  head,
  start,
  name,
}: ValueReadOptions): AttributeRead => {
  let position = start;
  while (isSpace(head[position])) {
    position += 1;
  }
  const quote = head[position];
  if (quote === undefined) {
    return { type: "end-of-input" };
  }
  if (quote === ">") {
    return { type: "attribute", name, value: "", next: position };
  }
  const quoted = quote === '"' || quote === "'";
  let value = "";
  position += quoted ? 1 : 0;
  for (;;) {
    const char = head[position];
    if (char === undefined) {
      return { type: "end-of-input" };
    }
    if (quoted && char === quote) {
      return { type: "attribute", name, value, next: position + 1 };
    }
    if (!quoted && (isSpace(char) || char === ">")) {
      return { type: "attribute", name, value, next: position };
    }
    value += asciiLower(char);
    position += 1;
  }
};

/** The HTML prescan's "get an attribute", from `start`. */
const readAttribute = (head: string, start: number): AttributeRead => {
  let position = start;
  while (isSpace(head[position]) || head[position] === "/") {
    position += 1;
  }
  if (head[position] === undefined) {
    return { type: "end-of-input" };
  }
  if (head[position] === ">") {
    return { type: "end-of-tag", next: position };
  }
  let name = "";
  for (;;) {
    const char = head[position];
    if (char === undefined) {
      return { type: "end-of-input" };
    }
    if (char === "=" && name.length > 0) {
      return readAttributeValue({ head, start: position + 1, name });
    }
    if (isSpace(char)) {
      while (isSpace(head[position])) {
        position += 1;
      }
      return head[position] === "="
        ? readAttributeValue({ head, start: position + 1, name })
        : { type: "attribute", name, value: "", next: position };
    }
    if (char === "/" || char === ">") {
      return { type: "attribute", name, value: "", next: position };
    }
    name += asciiLower(char);
    position += 1;
  }
};

/** The charset a `content="text/html; charset=…"` value names, or null. */
const charsetFromContent = (content: string): string | null => {
  let position = 0;
  for (;;) {
    const found = content.indexOf("charset", position);
    if (found === -1) {
      return null;
    }
    position = found + "charset".length;
    while (isSpace(content[position])) {
      position += 1;
    }
    if (content[position] !== "=") {
      continue;
    }
    position += 1;
    while (isSpace(content[position])) {
      position += 1;
    }
    const first = content[position];
    if (first === undefined) {
      return null;
    }
    if (first === '"' || first === "'") {
      const end = content.indexOf(first, position + 1);
      return end === -1 ? null : content.slice(position + 1, end);
    }
    let end = position;
    while (
      end < content.length &&
      !isSpace(content[end]) &&
      content[end] !== ";"
    ) {
      end += 1;
    }
    return content.slice(position, end);
  }
};

type TagRead =
  | { type: "charset"; label: string }
  | { type: "next"; next: number }
  | { type: "end-of-input" };

/** A `<meta>` tag's attributes, from just after its name. */
const readMeta = (head: string, start: number): TagRead => {
  const seen = new Set<string>();
  let gotPragma = false;
  let needPragma: boolean | null = null;
  let charset: string | null = null;
  let position = start;
  for (;;) {
    const read = readAttribute(head, position);
    if (read.type === "end-of-input") {
      return read;
    }
    if (read.type === "end-of-tag") {
      position = read.next;
      break;
    }
    position = read.next;
    if (seen.has(read.name)) {
      continue;
    }
    seen.add(read.name);
    if (read.name === "http-equiv" && read.value === "content-type") {
      gotPragma = true;
    } else if (read.name === "content" && charset === null) {
      const label = charsetFromContent(read.value);
      if (label !== null && decoderFor(label) !== null) {
        charset = label;
        needPragma = true;
      }
    } else if (read.name === "charset") {
      charset = decoderFor(read.value) === null ? null : read.value;
      needPragma = false;
    }
  }
  if (charset === null || needPragma === null || (needPragma && !gotPragma)) {
    return { type: "next", next: position + 1 };
  }
  return { type: "charset", label: charset };
};

/** Every attribute of a tag that is not `<meta>`, skipped as the prescan does. */
const skipTag = (head: string, start: number): TagRead => {
  let position = start;
  while (
    position < head.length &&
    !isSpace(head[position]) &&
    head[position] !== ">"
  ) {
    position += 1;
  }
  for (;;) {
    const read = readAttribute(head, position);
    if (read.type === "end-of-input") {
      return read;
    }
    position = read.next;
    if (read.type === "end-of-tag") {
      return { type: "next", next: position + 1 };
    }
  }
};

const META_START = /^<meta[\t\n\f\r /]/iu;

/** A start or end tag at `position`, read; null where none starts there. */
const readTag = (head: string, position: number): TagRead | null => {
  if (META_START.test(head.slice(position, position + 6))) {
    return readMeta(head, position + 5);
  }
  const opensTag =
    head[position] === "<" &&
    (isAsciiLetter(head[position + 1]) ||
      (head[position + 1] === "/" && isAsciiLetter(head[position + 2])));
  return opensTag ? skipTag(head, position + 1) : null;
};

/**
 * The HTML prescan for a character encoding
 * (https://html.spec.whatwg.org/multipage/parsing.html#prescan-a-byte-stream-to-determine-its-encoding):
 * comments and other tags' attributes are stepped over, so a declaration
 * quoted in either is not one. Its input is the bounded head of the bytes.
 */
const prescan = (head: string): string | null => {
  let position = 0;
  while (position < head.length) {
    if (head.startsWith("<!--", position)) {
      const end = head.indexOf("-->", position + 2);
      if (end === -1) {
        return null;
      }
      position = end + 3;
      continue;
    }
    const tag = readTag(head, position);
    if (tag !== null) {
      switch (tag.type) {
        case "charset":
          return tag.label;
        case "end-of-input":
          return null;
        case "next":
          position = tag.next;
          continue;
        default:
          tag satisfies never;
          return panic("Unhandled prescan tag read");
      }
    }
    if (/^<[!/?]/u.test(head.slice(position, position + 2))) {
      const end = head.indexOf(">", position);
      if (end === -1) {
        return null;
      }
      position = end + 1;
      continue;
    }
    position += 1;
  }
  return null;
};

/** An XML declaration, which only the very start of the bytes can hold. */
const XML_DECLARATION =
  /^<\?xml[\t\n\r ][^>]*?\bencoding\s*=\s*["'](?<label>[^"']+)["']/u;

const documentDecoder = (bytes: Uint8Array): LabelledTextDecoder | null => {
  const utf16 = prefixCharset(bytes, UTF16_XML_PREFIXES);
  if (utf16 !== null) {
    return new LabelledTextDecoder(utf16);
  }
  // Every other declaration is ASCII, and every charset it can name writes
  // ASCII as ASCII, so a byte-per-character reading finds it.
  const head = String.fromCodePoint(...bytes.subarray(0, PRESCAN_BYTES));
  const label = XML_DECLARATION.exec(head)?.groups?.["label"] ?? prescan(head);
  const declared = label === null ? null : decoderFor(label);
  // A declaration of UTF-16 in ASCII bytes is not UTF-16; WHATWG reads such
  // a document as UTF-8, and one declaring x-user-defined as windows-1252.
  if (declared?.encoding.startsWith("utf-16") === true) {
    return new LabelledTextDecoder("utf-8");
  }
  if (declared?.encoding === "x-user-defined") {
    return new LabelledTextDecoder("windows-1252");
  }
  return declared;
};

export const decodeDeclared = (
  bytes: Uint8Array,
  { contentType }: DecodeDeclaredOptions,
): DeclaredText => {
  const bom = prefixCharset(bytes, BOMS);
  if (bom !== null) {
    // The platform decoders strip the BOM they were built for.
    return {
      text: new LabelledTextDecoder(bom).decode(bytes),
      charset: bom,
      source: "bom",
    };
  }
  // The transport's charset is not written in the bytes, so UTF-16 there is
  // what it says.
  const httpLabel =
    contentType === null
      ? null
      : (HTTP_CHARSET.exec(contentType)?.groups?.["label"] ?? null);
  const http = httpLabel === null ? null : decoderFor(httpLabel);
  if (http !== null) {
    return { text: http.decode(bytes), charset: http.encoding, source: "http" };
  }
  const document = documentDecoder(bytes);
  if (document !== null) {
    return {
      text: document.decode(bytes),
      charset: document.encoding,
      source: "document",
    };
  }
  return {
    text: new TextDecoder().decode(bytes),
    charset: "utf-8",
    source: "default",
  };
};
