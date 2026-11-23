import { panic, Result } from "better-result";
import * as slimdom from "slimdom";

import { loadDocxArchive } from "@/api/lib/docx-archive";
import {
  CompoundFile,
  hasCompoundFileSignature,
} from "@/api/lib/files/compound-file";
import { DOCUMENT_METADATA_ENTRY_MAX_BYTES } from "@/api/lib/files/document-properties";
import type { ConvertibleMime } from "@/api/lib/files/pdf-derivative-policy";

/**
 * What a file's bytes are, read from the same signals the converter's
 * importers recognise. The converter opens a file by its content, not by its
 * declared type: a spreadsheet named `.rtf` is opened as a spreadsheet. The
 * input checks read a file as its declared type, so a file converts only when
 * its content is that type; anything else would reach an importer nothing
 * inspected it for.
 */
export type ConversionContent =
  | "word-binary"
  | "spreadsheet-binary"
  | "presentation-binary"
  | "works-binary"
  | "word-ooxml"
  | "spreadsheet-ooxml"
  | "presentation-ooxml"
  | "text-odf"
  | "spreadsheet-odf"
  | "presentation-odf"
  | "iwork"
  | "wordperfect"
  | "rtf"
  | "image"
  | "markup"
  | "text"
  | "unrecognised";

/**
 * The content each convertible type must have. Plain text and CSV are always
 * imported as text, whatever their bytes hold, so any content converts.
 */
const EXPECTED_CONTENT = {
  "application/msword": ["word-binary"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [
    "presentation-ooxml",
  ],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    "spreadsheet-ooxml",
  ],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "word-ooxml",
  ],
  "application/vnd.ms-excel": ["spreadsheet-binary"],
  "application/vnd.ms-powerpoint": ["presentation-binary"],
  "application/vnd.ms-works": ["works-binary"],
  "application/vnd.oasis.opendocument.presentation": ["presentation-odf"],
  "application/vnd.oasis.opendocument.spreadsheet": ["spreadsheet-odf"],
  "application/vnd.oasis.opendocument.text": ["text-odf"],
  "application/rtf": ["rtf"],
  "application/vnd.apple.numbers": ["iwork"],
  "application/vnd.apple.pages": ["iwork"],
  "application/vnd.wordperfect": ["wordperfect"],
  "application/wordperfect": ["wordperfect"],
  "application/wordperfect5.1": ["wordperfect"],
  "application/x-iwork-numbers-sffnumbers": ["iwork"],
  "application/x-iwork-pages-sffpages": ["iwork"],
  "application/x-wordperfect": ["wordperfect"],
  "application/xhtml+xml": ["markup", "text"],
  "image/bmp": ["image"],
  "image/gif": ["image"],
  "image/heic": ["image"],
  "image/heic-sequence": ["image"],
  "image/heif": ["image"],
  "image/heif-sequence": ["image"],
  "image/jpeg": ["image"],
  "image/png": ["image"],
  "image/tiff": ["image"],
  "image/webp": ["image"],
  "text/csv": "any",
  "text/html": ["markup", "text"],
  "text/plain": "any",
} as const satisfies Record<
  ConvertibleMime,
  readonly ConversionContent[] | "any"
>;

const startsWithBytes = (
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean =>
  bytes.byteLength >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (value: string): number[] =>
  Array.from(value, (character) => character.codePointAt(0) ?? 0);

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
/** `\xFFWPC`: the prefix of every WordPerfect 5.0 and later file. */
const WORDPERFECT_SIGNATURE = [0xff, 0x57, 0x50, 0x43];
const RTF_SIGNATURE = ascii("{\\rtf");

const IMAGE_SIGNATURES: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff],
  ascii("GIF87a"),
  ascii("GIF89a"),
  ascii("BM"),
  [0x49, 0x49, 0x2a, 0x00],
  [0x4d, 0x4d, 0x00, 0x2a],
];

/**
 * Major brands of the HEIF still image and image sequence files the HEIC
 * preview reads: HEVC-coded (`heic`, `heix`, `heim`, `heis`, `hevc`, `hevx`,
 * `hevm`, `hevs`) and the generic structural brands (`mif1`, `mif2`,
 * `msf1`) phones and cameras also write as the major brand.
 */
const HEIF_MAJOR_BRANDS: ReadonlySet<string> = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "hevm",
  "hevs",
  "mif1",
  "mif2",
  "msf1",
]);

/** An ISO base media file whose first box is `ftyp` with a HEIF major brand. */
const isHeif = (bytes: Uint8Array): boolean =>
  startsWithBytes(bytes, ascii("ftyp"), 4) &&
  bytes.byteLength >= 12 &&
  HEIF_MAJOR_BRANDS.has(String.fromCodePoint(...bytes.subarray(8, 12)));

const isImage = (bytes: Uint8Array): boolean =>
  IMAGE_SIGNATURES.some((signature) => startsWithBytes(bytes, signature)) ||
  (startsWithBytes(bytes, ascii("RIFF")) &&
    startsWithBytes(bytes, ascii("WEBP"), 8)) ||
  isHeif(bytes);

/** Top-level streams that name what a compound file is, compared uppercase. */
const COMPOUND_STREAM_CONTENT: ReadonlyMap<string, ConversionContent> = new Map(
  [
    ["WORDDOCUMENT", "word-binary"],
    ["WORKBOOK", "spreadsheet-binary"],
    ["BOOK", "spreadsheet-binary"],
    ["POWERPOINT DOCUMENT", "presentation-binary"],
    // Works 4 word-processor files keep their text in MN0; Works 5 and later
    // in CONTENTS.
    ["MN0", "works-binary"],
    ["CONTENTS", "works-binary"],
  ],
);

/** A file whose signals name more than one format, or none, is unrecognised. */
const onlyContent = (
  found: ReadonlySet<ConversionContent>,
): ConversionContent => {
  const [only, ...rest] = found;
  return only !== undefined && rest.length === 0 ? only : "unrecognised";
};

const compoundFileContent = (bytes: Uint8Array): ConversionContent => {
  const parsed = CompoundFile.parse(bytes);
  if (Result.isError(parsed)) {
    return "unrecognised";
  }
  const found = new Set<ConversionContent>();
  for (const { path } of parsed.value.streamEntries) {
    const [name] = path;
    const content =
      path.length === 1 && name !== undefined
        ? COMPOUND_STREAM_CONTENT.get(name.toUpperCase())
        : undefined;
    if (content !== undefined) {
      found.add(content);
    }
  }
  return onlyContent(found);
};

/**
 * The main part content types of OOXML packages, lower-cased: the document,
 * template and macro-enabled variants of each family.
 */
const OOXML_MAIN_CONTENT_TYPE =
  /^application\/vnd\.(?:openxmlformats-officedocument\.(wordprocessingml|spreadsheetml|presentationml)\.[a-z]+|ms-(word|excel|powerpoint)\.[a-z]+\.macroenabled(?:template)?)\.main\+xml$/u;

const OPC_CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const OPC_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";

const childElements = (
  document: slimdom.Document,
  namespace: string,
  localName: string,
): slimdom.Element[] =>
  document.documentElement?.namespaceURI === namespace
    ? document.documentElement.children.filter(
        (child) =>
          child.namespaceURI === namespace && child.localName === localName,
      )
    : [];

/**
 * The content type of an OOXML package's main part, as the converter reads
 * it: the target of the package's office-document relationship, typed by its
 * `Override` in `[Content_Types].xml`, else by the `Default` for its
 * extension. Part names compare case-insensitively.
 */
const ooxmlMainContentType = (
  contentTypesXml: string,
  relationshipsXml: string,
): string | null => {
  const relationship = childElements(
    slimdom.parseXmlDocument(relationshipsXml),
    OPC_RELATIONSHIPS_NAMESPACE,
    "Relationship",
  ).find(
    (element) =>
      (element.getAttribute("Type") ?? "").endsWith("/officeDocument") &&
      element.getAttribute("TargetMode") !== "External",
  );
  const target = relationship?.getAttribute("Target");
  if (target === undefined || target === null || target === "") {
    return null;
  }
  // A target is a URI reference relative to the package root ("./word/…",
  // "%20" escapes); its part name is the resolved path.
  const resolved = Result.try(() =>
    decodeURIComponent(new URL(target, "http://package/").pathname),
  );
  if (Result.isError(resolved)) {
    return null;
  }
  const partName = resolved.value.toLowerCase();
  const contentTypes = slimdom.parseXmlDocument(contentTypesXml);
  const override = childElements(
    contentTypes,
    OPC_CONTENT_TYPES_NAMESPACE,
    "Override",
  ).find(
    (element) => element.getAttribute("PartName")?.toLowerCase() === partName,
  );
  if (override !== undefined) {
    return override.getAttribute("ContentType");
  }
  const extension = partName.slice(partName.lastIndexOf(".") + 1);
  const fallback = childElements(
    contentTypes,
    OPC_CONTENT_TYPES_NAMESPACE,
    "Default",
  ).find(
    (element) => element.getAttribute("Extension")?.toLowerCase() === extension,
  );
  return fallback?.getAttribute("ContentType") ?? null;
};

const ooxmlContent = (
  contentTypesXml: string | null,
  relationshipsXml: string | null,
): ConversionContent => {
  if (contentTypesXml === null || relationshipsXml === null) {
    return "unrecognised";
  }
  const mainContentType = Result.try(() =>
    ooxmlMainContentType(contentTypesXml, relationshipsXml),
  );
  if (Result.isError(mainContentType)) {
    return "unrecognised";
  }
  const main = OOXML_MAIN_CONTENT_TYPE.exec(
    mainContentType.value?.trim().toLowerCase() ?? "",
  );
  if (main === null) {
    return "unrecognised";
  }
  const [, openXmlFamily, macroFamily] = main;
  return (
    OOXML_FAMILY_CONTENT.get(openXmlFamily ?? macroFamily ?? "") ??
    "unrecognised"
  );
};

const OOXML_FAMILY_CONTENT: ReadonlyMap<string, ConversionContent> = new Map([
  ["wordprocessingml", "word-ooxml"],
  ["word", "word-ooxml"],
  ["spreadsheetml", "spreadsheet-ooxml"],
  ["excel", "spreadsheet-ooxml"],
  ["presentationml", "presentation-ooxml"],
  ["powerpoint", "presentation-ooxml"],
]);

const ODF_MIMETYPE_CONTENT: ReadonlyMap<string, ConversionContent> = new Map([
  ["application/vnd.oasis.opendocument.text", "text-odf"],
  ["application/vnd.oasis.opendocument.text-template", "text-odf"],
  ["application/vnd.oasis.opendocument.text-master", "text-odf"],
  ["application/vnd.oasis.opendocument.spreadsheet", "spreadsheet-odf"],
  [
    "application/vnd.oasis.opendocument.spreadsheet-template",
    "spreadsheet-odf",
  ],
  ["application/vnd.oasis.opendocument.presentation", "presentation-odf"],
  [
    "application/vnd.oasis.opendocument.presentation-template",
    "presentation-odf",
  ],
]);

/**
 * Entries only an iWork package (Pages, Numbers or Keynote) has: the index of
 * the current format, of Keynote 6, and of the iWork '09 XML formats.
 */
const IWORK_INDEX_ENTRIES = [
  "Index/Document.iwa",
  "Index.zip",
  "index.xml",
  "index.xml.gz",
  "index.apxl",
  "index.apxl.gz",
] as const;

/**
 * An XML part's text in its encoding, detected as XML specifies: a byte
 * order mark, else UTF-16 by the zero byte beside its first `<`, else UTF-8.
 */
const decodeXml = (bytes: Uint8Array): string => {
  if (
    startsWithBytes(bytes, [0xff, 0xfe]) ||
    startsWithBytes(bytes, [0x3c, 0x00])
  ) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (
    startsWithBytes(bytes, [0xfe, 0xff]) ||
    startsWithBytes(bytes, [0x00, 0x3c])
  ) {
    return new TextDecoder("utf-16be").decode(bytes);
  }
  return new TextDecoder().decode(bytes);
};

const zipContent = async (bytes: Uint8Array): Promise<ConversionContent> => {
  const archive = await Result.tryPromise(
    async () => await loadDocxArchive(bytes),
  );
  if (Result.isError(archive)) {
    return "unrecognised";
  }
  const { zip } = archive.value;
  const paths = new Set(zip.paths());
  const readSmallText = async (path: string): Promise<string | null> => {
    const entry = zip.entry(path);
    if (entry === undefined || entry.size > DOCUMENT_METADATA_ENTRY_MAX_BYTES) {
      return null;
    }
    return decodeXml(await entry.bytes());
  };

  const found = new Set<ConversionContent>();
  if (paths.has("[Content_Types].xml")) {
    // A package whose main part is no office document (a drawing, an XPS
    // file) is still a package, of no format that converts.
    found.add(
      ooxmlContent(
        await readSmallText("[Content_Types].xml"),
        await readSmallText("_rels/.rels"),
      ),
    );
  }
  if (paths.has("mimetype")) {
    const mimetype = (await readSmallText("mimetype"))?.trim() ?? "";
    found.add(ODF_MIMETYPE_CONTENT.get(mimetype) ?? "unrecognised");
  } else if (paths.has("META-INF/manifest.xml")) {
    found.add("unrecognised");
  }
  if (IWORK_INDEX_ENTRIES.some((path) => paths.has(path))) {
    found.add("iwork");
  }
  return onlyContent(found);
};

/** The first bytes the text checks read; importers sniff no further. */
const TEXT_SNIFF_BYTES = 64 * 1024;

const decodeTextPrefix = (bytes: Uint8Array): string => {
  const prefix = bytes.subarray(0, TEXT_SNIFF_BYTES);
  if (startsWithBytes(prefix, [0xff, 0xfe])) {
    return new TextDecoder("utf-16le").decode(prefix.subarray(2));
  }
  if (startsWithBytes(prefix, [0xfe, 0xff])) {
    return new TextDecoder("utf-16be").decode(prefix.subarray(2));
  }
  return new TextDecoder().decode(prefix).replace(/^﻿/u, "");
};

/**
 * Text formats with their own importer, recognised by how they begin: SYLK,
 * DIF and PostScript. (RTF, PDF and the binary formats are matched first.)
 */
const OTHER_TEXT_FORMAT_PREFIXES = ["ID;", "TABLE\r\n", "TABLE\n", "%!"];

/**
 * The elements the converter's HTML importer recognises as the start of an
 * HTML document (its HTML 4 vocabulary). A document whose first element is
 * anything else (`svg`, `math`, a DocBook `article`, a flat OpenDocument or
 * Word XML root) is opened by another importer.
 */
const HTML_START_ELEMENTS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "acronym",
  "address",
  "area",
  "b",
  "base",
  "basefont",
  "big",
  "blockquote",
  "body",
  "br",
  "button",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "font",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "html",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "link",
  "map",
  "meta",
  "nobr",
  "ol",
  "option",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "select",
  "small",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
]);

type FirstElement =
  | { readonly kind: "element"; readonly name: string }
  /** No markup at all: text. */
  | { readonly kind: "none" }
  /** A document type other than HTML's, which another importer may claim. */
  | { readonly kind: "foreign" };

const HTML_DOCTYPE = /^<!doctype\s+html[\s>]/iu;

/** The first element after the prolog: comments, instructions, a doctype. */
const firstElement = (source: string): FirstElement => {
  let at = 0;
  for (;;) {
    while (at < source.length && /\s/u.test(source.charAt(at))) {
      at += 1;
    }
    if (source.startsWith("<!--", at)) {
      const end = source.indexOf("-->", at + 4);
      if (end === -1) {
        return { kind: "none" };
      }
      at = end + 3;
    } else if (source.startsWith("<?", at)) {
      const end = source.indexOf("?>", at + 2);
      if (end === -1) {
        return { kind: "none" };
      }
      at = end + 2;
    } else if (source.startsWith("<!", at)) {
      const end = source.indexOf(">", at + 2);
      if (end === -1 || !HTML_DOCTYPE.test(source.slice(at, end + 1))) {
        return { kind: "foreign" };
      }
      at = end + 1;
    } else {
      break;
    }
  }
  if (source.charAt(at) !== "<") {
    return { kind: "none" };
  }
  const name = /^<([^\s/>]+)/u.exec(source.slice(at, at + 256))?.[1] ?? "";
  return { kind: "element", name };
};

const textContent = (bytes: Uint8Array): ConversionContent => {
  const source = decodeTextPrefix(bytes);
  if (
    source.includes("\u0000") ||
    OTHER_TEXT_FORMAT_PREFIXES.some((prefix) => source.startsWith(prefix))
  ) {
    return "unrecognised";
  }
  const element = firstElement(source);
  switch (element.kind) {
    case "none":
      return "text";
    case "foreign":
      return "unrecognised";
    case "element":
      return HTML_START_ELEMENTS.has(element.name.toLowerCase())
        ? "markup"
        : "unrecognised";
    default:
      element satisfies never;
      return panic("Unexpected first element");
  }
};

/** What `bytes` are, by the signals the converter's importers recognise. */
export const conversionContent = async (
  bytes: Uint8Array,
): Promise<ConversionContent> => {
  if (hasCompoundFileSignature(bytes)) {
    return compoundFileContent(bytes);
  }
  if (startsWithBytes(bytes, ZIP_LOCAL_HEADER)) {
    return await zipContent(bytes);
  }
  if (startsWithBytes(bytes, WORDPERFECT_SIGNATURE)) {
    return "wordperfect";
  }
  if (isImage(bytes)) {
    return "image";
  }
  if (startsWithBytes(bytes, RTF_SIGNATURE)) {
    return "rtf";
  }
  if (startsWithBytes(bytes, ascii("%PDF-"))) {
    return "unrecognised";
  }
  return textContent(bytes);
};

/** Whether `bytes` are the format `mime` declares, as the converter reads it. */
export const contentMatchesConvertibleMime = async (
  mime: ConvertibleMime,
  bytes: Uint8Array,
): Promise<boolean> => {
  const expected: readonly ConversionContent[] | "any" = EXPECTED_CONTENT[mime];
  return (
    expected === "any" || expected.includes(await conversionContent(bytes))
  );
};
