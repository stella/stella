import { panic, Result, TaggedError } from "better-result";
import { isTag } from "domhandler";
import * as slimdom from "slimdom";

import type { ConversionRefusal } from "@stll/api-contract/conversion-refusal";
import { load } from "@stll/html";

import { loadDocxArchive } from "@/api/lib/docx-archive";
import { CompoundFile } from "@/api/lib/files/compound-file";
import { DOCUMENT_METADATA_ENTRY_MAX_BYTES } from "@/api/lib/files/document-properties";
import type { ConvertibleMime } from "@/api/lib/files/pdf-derivative-policy";

type ConversionInputResult =
  | { kind: "convert" }
  | {
      kind: "refuse";
      format: ConvertibleMime;
      reason: ConversionInputRefusal;
    };

export type ConversionInputRefusal =
  | { kind: "external_reference" }
  | ConversionRefusal
  | { kind: "inspection_failed" };

type Detector = (bytes: Uint8Array) => Promise<boolean> | boolean;

type ReferenceRefusal = Extract<
  ConversionInputRefusal,
  { kind: "unsupported_reference" }
>;

type InspectedMarkupFormat = "html" | "xhtml" | "ooxml" | "odf";

export const REFERENCE_ALLOWLIST = [
  {
    format: "xhtml",
    element: "*",
    attribute: "{http://www.w3.org/2000/xmlns/}*",
    reason: "namespace declaration",
  },
  {
    format: "ooxml",
    element: "*",
    attribute: "{http://www.w3.org/2000/xmlns/}*",
    reason: "namespace declaration",
  },
  {
    format: "ooxml",
    element: "{http://www.w3.org/2001/XMLSchema}schema",
    attribute: "targetNamespace",
    reason: "schema namespace identifier in custom XML schema parts",
  },
  {
    format: "ooxml",
    element: "{http://www.w3.org/2001/XMLSchema}import",
    attribute: "namespace",
    reason: "imported schema namespace identifier",
  },
  {
    format: "ooxml",
    element: "{http://www.w3.org/2001/XMLSchema}import",
    attribute: "schemaLocation",
    reason:
      "schema location hint in custom XML schema parts; document conversion does not load XML Schema imports",
  },
  {
    format: "odf",
    element: "*",
    attribute: "{http://www.w3.org/2000/xmlns/}*",
    reason: "namespace declaration",
  },
  {
    format: "html",
    element: "*",
    attribute: "xmlns",
    reason: "namespace declaration",
  },
  {
    format: "html",
    element: "*",
    attribute: "xmlns:*",
    reason: "namespace declaration",
  },
  { format: "html", element: "a", attribute: "href", reason: "navigation" },
  {
    format: "html",
    element: "area",
    attribute: "href",
    reason: "navigation",
  },
  {
    format: "xhtml",
    element: "{http://www.w3.org/1999/xhtml}a",
    attribute: "href",
    reason: "navigation",
  },
  {
    format: "xhtml",
    element: "{http://www.w3.org/1999/xhtml}area",
    attribute: "href",
    reason: "navigation",
  },
  {
    format: "xhtml",
    element: "a",
    attribute: "href",
    reason: "navigation",
  },
  {
    format: "xhtml",
    element: "area",
    attribute: "href",
    reason: "navigation",
  },
  {
    format: "ooxml",
    element:
      "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship",
    attribute: "Target",
    reason: "navigation hyperlink target",
  },
  {
    format: "ooxml",
    element: "{http://purl.oclc.org/ooxml/package/relationships}Relationship",
    attribute: "Target",
    reason: "navigation hyperlink target",
  },
  {
    format: "ooxml",
    element: "Relationship",
    attribute: "Target",
    reason: "navigation hyperlink target",
  },
  {
    format: "ooxml",
    element:
      "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship",
    attribute: "Type",
    reason: "schema identifier",
  },
  {
    format: "ooxml",
    element: "{http://purl.oclc.org/ooxml/package/relationships}Relationship",
    attribute: "Type",
    reason: "schema identifier",
  },
  {
    format: "ooxml",
    element: "Relationship",
    attribute: "Type",
    reason: "schema identifier",
  },
  {
    format: "odf",
    element: "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}a",
    attribute: "{http://www.w3.org/1999/xlink}href",
    reason: "navigation",
  },
  {
    format: "ooxml",
    element: "*",
    attribute: "uri",
    reason: "extension schema identifier",
  },
  {
    format: "ooxml",
    element:
      "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}compatSetting",
    attribute:
      "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}uri",
    reason: "compatibility schema identifier",
  },
  {
    format: "ooxml",
    element:
      "{http://schemas.openxmlformats.org/officeDocument/2006/customXml}schemaRef",
    attribute:
      "{http://schemas.openxmlformats.org/officeDocument/2006/customXml}uri",
    reason: "custom XML schema identifier",
  },
  {
    format: "ooxml",
    element: "{http://purl.oclc.org/ooxml/officeDocument/customXml}schemaRef",
    attribute: "{http://purl.oclc.org/ooxml/officeDocument/customXml}uri",
    reason: "custom XML schema identifier",
  },
  {
    format: "ooxml",
    element: "{http://purl.oclc.org/ooxml/wordprocessingml/main}compatSetting",
    attribute: "{http://purl.oclc.org/ooxml/wordprocessingml/main}uri",
    reason: "compatibility schema identifier",
  },
  {
    format: "ooxml",
    element:
      "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}docVar",
    attribute:
      "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val",
    reason: "document variable value; stored data, never loaded",
  },
  {
    format: "ooxml",
    element: "{http://purl.oclc.org/ooxml/wordprocessingml/main}docVar",
    attribute: "{http://purl.oclc.org/ooxml/wordprocessingml/main}val",
    reason: "document variable value; stored data, never loaded",
  },
  {
    format: "ooxml",
    element:
      "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}hyperlink",
    attribute:
      "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id",
    reason: "navigation",
  },
  {
    format: "ooxml",
    element: "{http://purl.oclc.org/ooxml/wordprocessingml/main}hyperlink",
    attribute: "{http://purl.oclc.org/ooxml/officeDocument/relationships}id",
    reason: "navigation",
  },
] as const satisfies readonly {
  format: InspectedMarkupFormat;
  element: string;
  attribute: string;
  reason: string;
}[];

export type ReferenceAllowlist = readonly {
  format: InspectedMarkupFormat;
  element: string;
  attribute: string;
  reason: string;
}[];

type SupportedEncoding = "utf-8" | "utf-16le" | "utf-16be";

type DecodedText =
  | { kind: "source"; value: string }
  | { kind: "unsupported_encoding"; encoding: string };

const normalizeEncoding = (encoding: string): string =>
  encoding.trim().toLowerCase().replaceAll("_", "-");

const supportedEncoding = (encoding: string): SupportedEncoding | null => {
  const normalized = normalizeEncoding(encoding);
  if (/^utf8$/u.test(normalized)) {
    return "utf-8";
  }
  switch (normalized) {
    case "unicode-1-1-utf-8":
    case "utf-8":
      return "utf-8";
    case "utf-16":
    case "utf-16le":
      return "utf-16le";
    case "utf-16be":
      return "utf-16be";
    default:
      return null;
  }
};

const bomEncoding = (bytes: Uint8Array): SupportedEncoding | null => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  return null;
};

const signatureEncoding = (bytes: Uint8Array): SupportedEncoding | null => {
  if (bytes[0] === 0x3c && bytes[1] === 0x00) {
    return "utf-16le";
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x3c) {
    return "utf-16be";
  }
  return null;
};

const declaredEncoding = (source: string): string | null => {
  const prefix = source.slice(0, 2048);
  const xml = /<\?xml\s[^>]*\bencoding\s*=\s*["']\s*([^\s"']+)/iu.exec(
    prefix,
  )?.[1];
  if (xml !== undefined) {
    return normalizeEncoding(xml);
  }
  const $ = load(prefix);
  for (const node of $("meta").toArray()) {
    if (!isTag(node)) {
      continue;
    }
    const charset = node.attribs["charset"];
    if (charset !== undefined) {
      return normalizeEncoding(charset);
    }
    if (node.attribs["http-equiv"]?.toLowerCase() !== "content-type") {
      continue;
    }
    const content = node.attribs["content"] ?? "";
    const declared = /\bcharset\s*=\s*([^\s;"']+)/iu.exec(content)?.[1];
    if (declared !== undefined) {
      return normalizeEncoding(declared);
    }
  }
  return null;
};

const decodeText = (bytes: Uint8Array): DecodedText => {
  const bom = bomEncoding(bytes);
  const detected = bom ?? signatureEncoding(bytes) ?? "utf-8";
  const tentative = new TextDecoder(detected).decode(bytes);
  const declaration = declaredEncoding(tentative);
  if (declaration === null) {
    return { kind: "source", value: tentative };
  }
  const declared = supportedEncoding(declaration);
  if (declared === null) {
    return { kind: "unsupported_encoding", encoding: declaration };
  }
  // A byte order mark decides the encoding for every reader. Without one, the
  // converter reads the bytes by their signature, so the inspected text is
  // only that decoding; a declaration naming another encoding is refused.
  const matchesBytes =
    declared === detected || (declaration === "utf-16" && detected !== "utf-8");
  if (bom === null && !matchesBytes) {
    return { kind: "unsupported_encoding", encoding: declaration };
  }
  return { kind: "source", value: tentative };
};

const latin1 = (bytes: Uint8Array): string =>
  new TextDecoder("windows-1252").decode(bytes);

const isSchemeCharacter = (character: string): boolean =>
  (character >= "a" && character <= "z") ||
  (character >= "0" && character <= "9") ||
  character === "+" ||
  character === "-" ||
  character === ".";

const FETCHABLE_SCHEMES = [
  { scheme: "http", reason: "web resource" },
  { scheme: "https", reason: "web resource" },
  { scheme: "ftp", reason: "file transfer resource" },
  { scheme: "file", reason: "filesystem resource" },
  { scheme: "smb", reason: "network share resource" },
  { scheme: "mhtml", reason: "web archive resource" },
  { scheme: "jar", reason: "archive resource" },
] as const satisfies readonly { scheme: string; reason: string }[];

type FetchableScheme = (typeof FETCHABLE_SCHEMES)[number]["scheme"];
const FETCHABLE_SCHEME_NAMES: ReadonlySet<string> = new Set<FetchableScheme>(
  FETCHABLE_SCHEMES.map(({ scheme }) => scheme),
);

// URL parsers drop control characters (tab, newline) anywhere in a URL and
// trim the ends, so every reference check classifies the value they load.
const normalizeUrlValue = (value: string): string => {
  let normalized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) {
      normalized += character;
    }
  }
  return normalized.trim().toLowerCase();
};

const isExternalReference = (value: string): boolean => {
  const normalized = normalizeUrlValue(value);
  if (
    normalized.startsWith("#") ||
    normalized.startsWith("data:") ||
    normalized.startsWith("cid:")
  ) {
    return false;
  }
  if (normalized.startsWith("//") || normalized.startsWith("\\\\")) {
    return true;
  }
  const colon = normalized.indexOf(":");
  const first = normalized.charAt(0);
  if (colon <= 0 || first < "a" || first > "z") {
    return false;
  }
  for (let index = 1; index < colon; index++) {
    if (!isSchemeCharacter(normalized[index] ?? "")) {
      return false;
    }
  }
  const scheme = normalized.slice(0, colon);
  return (
    normalized.slice(colon + 1).startsWith("//") ||
    FETCHABLE_SCHEME_NAMES.has(scheme)
  );
};

const RASTER_DATA_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const isUnsupportedDataUrl = (value: string): boolean => {
  const normalized = normalizeUrlValue(value);
  if (!normalized.startsWith("data:")) {
    return false;
  }
  const mediaType = normalized.slice(5).split(/[;,]/u, 1)[0] ?? "";
  return !RASTER_DATA_MEDIA_TYPES.has(mediaType);
};

const normalizeCss = (source: string): string | null => {
  let normalized = "";
  for (let cursor = 0; cursor < source.length; cursor++) {
    if (source[cursor] === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2);
      if (end === -1) {
        return null;
      }
      normalized += " ";
      cursor = end + 1;
      continue;
    }
    if (source[cursor] !== "\\") {
      normalized += source[cursor];
      continue;
    }
    cursor++;
    if (cursor >= source.length) {
      return null;
    }
    if (source[cursor] === "\n" || source[cursor] === "\f") {
      continue;
    }
    if (source[cursor] === "\r") {
      if (source[cursor + 1] === "\n") {
        cursor++;
      }
      continue;
    }
    const hex = /^[\da-f]{1,6}/iu.exec(source.slice(cursor))?.[0];
    if (hex === undefined) {
      normalized += source[cursor];
      continue;
    }
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint === 0 || codePoint > 0x10_ff_ff) {
      return null;
    }
    normalized += String.fromCodePoint(codePoint);
    cursor += hex.length - 1;
    if (/\s/u.test(source[cursor + 1] ?? "")) {
      cursor++;
    }
  }
  return normalized;
};

const nextCssReference = (
  lower: string,
  cursor: number,
): { at: number; markerLength: number } | null => {
  const urlAt = lower.indexOf("url(", cursor);
  const importAt = lower.indexOf("@import", cursor);
  if (urlAt === -1 && importAt === -1) {
    return null;
  }
  if (urlAt === -1) {
    return { at: importAt, markerLength: 7 };
  }
  if (importAt === -1 || urlAt < importAt) {
    return { at: urlAt, markerLength: 4 };
  }
  return { at: importAt, markerLength: 7 };
};

const cssHasExternalReference = (source: string): boolean => {
  const normalized = normalizeCss(source);
  if (normalized === null) {
    return true;
  }
  const lower = normalized.toLowerCase();
  let cursor = 0;
  while (cursor < lower.length) {
    const reference = nextCssReference(lower, cursor);
    if (reference === null) {
      return false;
    }
    const isUrl = reference.markerLength === 4;
    let valueAt = reference.at + reference.markerLength;
    while (valueAt < lower.length && /\s/u.test(lower[valueAt] ?? "")) {
      valueAt++;
    }
    if (!isUrl && lower.slice(valueAt, valueAt + 4) === "url(") {
      valueAt += 4;
      while (valueAt < lower.length && /\s/u.test(lower[valueAt] ?? "")) {
        valueAt++;
      }
    }
    if (valueAt >= lower.length) {
      return true;
    }
    const quote = lower[valueAt];
    const quoted = quote === '"' || quote === "'";
    if (quoted) {
      valueAt++;
    }
    let end = valueAt;
    if (quoted) {
      while (end < lower.length && lower[end] !== quote) {
        end++;
      }
    } else {
      while (end < lower.length && !/[\s;)]/u.test(lower[end] ?? "")) {
        end++;
      }
    }
    if (end === valueAt || (quoted && end >= lower.length)) {
      return true;
    }
    const value = normalized.slice(valueAt, end);
    if (isExternalReference(value) || isUnsupportedDataUrl(value)) {
      return true;
    }
    cursor = end + 1;
  }
  return false;
};

const htmlHasExternalReference = (source: string): boolean => {
  const $ = load(source);
  for (const node of $("*").toArray()) {
    if (!isTag(node)) {
      continue;
    }
    const name = node.name.toLowerCase();
    const adjustedAttributeName = (key: string): string => {
      const prefix = node["x-attribsPrefix"]?.[key];
      return prefix === undefined ? key : [prefix, key].join(":");
    };
    const attributes = Object.entries(node.attribs);
    const attribute = (wanted: string) =>
      attributes.find(
        ([key]) => adjustedAttributeName(key).toLowerCase() === wanted,
      )?.[1];
    if (
      name === "base" ||
      (name === "meta" && attribute("http-equiv")?.toLowerCase() === "refresh")
    ) {
      return true;
    }
    for (const [rawKey, value] of attributes) {
      const key = adjustedAttributeName(rawKey).toLowerCase();
      if (key === "style" && cssHasExternalReference(value)) {
        return true;
      }
      if (key === "srcset") {
        if (
          value
            .split(",")
            .some((candidate) =>
              isExternalReference(candidate.trim().split(/\s/u)[0] ?? ""),
            )
        ) {
          return true;
        }
        continue;
      }
      const isForeignContentLoader =
        node.namespace !== "http://www.w3.org/1999/xhtml" &&
        ["image", "use", "feimage", "script"].includes(name);
      const isHtmlContentLoader =
        (key === "src" &&
          [
            "audio",
            "embed",
            "frame",
            "iframe",
            "img",
            "input",
            "script",
            "source",
            "track",
            "video",
          ].includes(name)) ||
        (key === "data" && name === "object");
      const reference =
        ["poster", "background", "action", "formaction"].includes(key) ||
        isHtmlContentLoader ||
        (key === "href" && name !== "a" && name !== "area") ||
        ((key === "href" || key === ["xlink", "href"].join(":")) &&
          isForeignContentLoader);
      if (reference && isExternalReference(value)) {
        return true;
      }
    }
    if (name === "style" && cssHasExternalReference($(node).text())) {
      return true;
    }
  }
  return false;
};

const xmlElements = function* (
  element: slimdom.Element | null,
): Generator<slimdom.Element> {
  if (element === null) {
    return;
  }
  yield element;
  for (const child of element.childNodes) {
    if (child instanceof slimdom.Element) {
      yield* xmlElements(child);
    }
  }
};

const XML_NAMESPACES = {
  none: new Set([null]),
  officeDocumentRelationships: new Set([
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
  ]),
  relationships: new Set([
    "http://schemas.openxmlformats.org/package/2006/relationships",
    "http://purl.oclc.org/ooxml/package/relationships",
  ]),
  svg: new Set(["http://www.w3.org/2000/svg"]),
  text: new Set(["urn:oasis:names:tc:opendocument:xmlns:text:1.0"]),
  wordprocessing: new Set([
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",
  ]),
  xhtml: new Set(["http://www.w3.org/1999/xhtml"]),
  xlink: new Set(["http://www.w3.org/1999/xlink"]),
} as const;

const HYPERLINK_RELATIONSHIP_TYPES = new Set(
  [...XML_NAMESPACES.officeDocumentRelationships].map(
    (namespace) => `${namespace}/hyperlink`,
  ),
);

const xmlNameMatches = (
  node: slimdom.Element | slimdom.Attr,
  namespaces: ReadonlySet<string | null>,
  localName: string,
): boolean =>
  namespaces.has(node.namespaceURI) &&
  node.localName.toLowerCase() === localName.toLowerCase();

const xmlAttribute = (
  element: slimdom.Element,
  namespaces: ReadonlySet<string | null>,
  localName: string,
): string | null => {
  for (const attribute of element.attributes) {
    if (xmlNameMatches(attribute, namespaces, localName)) {
      return attribute.value;
    }
  }
  return null;
};

const xmlQualifiedName = (node: slimdom.Element | slimdom.Attr): string =>
  node.namespaceURI === null
    ? node.localName
    : `{${node.namespaceURI}}${node.localName}`;

const allowlistMatches = (
  format: InspectedMarkupFormat,
  element: string,
  attribute: string,
  referenceAllowlist: ReferenceAllowlist,
): boolean =>
  referenceAllowlist.some(
    (entry) =>
      entry.format === format &&
      (entry.element === "*" || entry.element === element) &&
      (entry.attribute === attribute ||
        (entry.attribute.endsWith("*") &&
          attribute.startsWith(entry.attribute.slice(0, -1)))),
  );

const valueHasExternalReference = (value: string): boolean =>
  isExternalReference(value) ||
  isUnsupportedDataUrl(value) ||
  cssHasExternalReference(value);

const QNAME_ATTRIBUTES = [
  {
    namespace: "http://www.w3.org/2001/XMLSchema-instance",
    localName: "type",
    reason: "schema type name",
  },
] as const satisfies readonly {
  namespace: string;
  localName: string;
  reason: string;
}[];

const isQNameAttribute = (attribute: slimdom.Attr): boolean =>
  QNAME_ATTRIBUTES.some(
    ({ namespace, localName }) =>
      attribute.namespaceURI === namespace &&
      attribute.localName.toLowerCase() === localName,
  );

const xmlCatchAllRefusal = (
  source: string,
  mime: ConvertibleMime,
  format: Exclude<InspectedMarkupFormat, "html">,
  referenceAllowlist: ReferenceAllowlist,
): ReferenceRefusal | null => {
  const document = slimdom.parseXmlDocument(source);
  for (const element of xmlElements(document.documentElement)) {
    const elementName = xmlQualifiedName(element);
    for (const attribute of element.attributes) {
      if (isQNameAttribute(attribute)) {
        continue;
      }
      const attributeName = xmlQualifiedName(attribute);
      if (attribute.localName.toLowerCase() === "srcdoc") {
        return {
          kind: "unsupported_reference",
          format: mime,
          element: elementName,
          attribute: attributeName,
        };
      }
      if (!valueHasExternalReference(attribute.value)) {
        continue;
      }
      if (
        allowlistMatches(
          format,
          elementName,
          attributeName,
          referenceAllowlist,
        ) &&
        (format !== "ooxml" ||
          attribute.localName.toLowerCase() !== "target" ||
          HYPERLINK_RELATIONSHIP_TYPES.has(
            xmlAttribute(element, XML_NAMESPACES.none, "type")?.trim() ?? "",
          ))
      ) {
        continue;
      }
      return {
        kind: "unsupported_reference",
        format: mime,
        element: elementName,
        attribute: attributeName,
      };
    }
  }
  return null;
};

const htmlCatchAllRefusal = (
  source: string,
  mime: ConvertibleMime,
  referenceAllowlist: ReferenceAllowlist,
): ReferenceRefusal | null => {
  const $ = load(source);
  for (const node of $("*").toArray()) {
    if (!isTag(node)) {
      continue;
    }
    const element = node.name.toLowerCase();
    for (const [attribute, value] of Object.entries(node.attribs)) {
      const name = attribute.toLowerCase();
      if (name === "srcdoc") {
        return {
          kind: "unsupported_reference",
          format: mime,
          element,
          attribute: name,
        };
      }
      if (
        valueHasExternalReference(value) &&
        !allowlistMatches("html", element, name, referenceAllowlist)
      ) {
        return {
          kind: "unsupported_reference",
          format: mime,
          element,
          attribute: name,
        };
      }
    }
  }
  return null;
};

const htmlStyleAttributeRefusal = (
  source: string,
  mime: ConvertibleMime,
): ReferenceRefusal | null => {
  const $ = load(source);
  for (const node of $("*").toArray()) {
    if (!isTag(node)) {
      continue;
    }
    const style = Object.entries(node.attribs).find(
      ([attribute]) => attribute.toLowerCase() === "style",
    );
    if (style !== undefined && cssHasExternalReference(style[1])) {
      return {
        kind: "unsupported_reference",
        format: mime,
        element: node.name.toLowerCase(),
        attribute: "style",
      };
    }
  }
  return null;
};

const relationshipHasExternalReference = (source: string): boolean => {
  const document = slimdom.parseXmlDocument(source);
  for (const element of xmlElements(document.documentElement)) {
    if (
      !xmlNameMatches(element, XML_NAMESPACES.relationships, "relationship") &&
      !xmlNameMatches(element, XML_NAMESPACES.none, "relationship")
    ) {
      continue;
    }
    const targetMode = xmlAttribute(element, XML_NAMESPACES.none, "targetmode");
    const target = xmlAttribute(element, XML_NAMESPACES.none, "target");
    const relationshipType = xmlAttribute(
      element,
      XML_NAMESPACES.none,
      "type",
    )?.trim();
    if (
      relationshipType !== undefined &&
      HYPERLINK_RELATIONSHIP_TYPES.has(relationshipType)
    ) {
      continue;
    }
    if (
      targetMode?.toLowerCase() === "external" ||
      (target !== null && isExternalReference(target))
    ) {
      return true;
    }
  }
  return false;
};

const xhtmlHasExternalReference = (source: string): boolean => {
  const document = slimdom.parseXmlDocument(source);
  for (const element of xmlElements(document.documentElement)) {
    const isXhtmlElement = (localName: string): boolean =>
      xmlNameMatches(element, XML_NAMESPACES.xhtml, localName) ||
      xmlNameMatches(element, XML_NAMESPACES.none, localName);
    const isNavigation = isXhtmlElement("a") || isXhtmlElement("area");
    if (
      isXhtmlElement("base") ||
      (isXhtmlElement("meta") &&
        xmlAttribute(
          element,
          XML_NAMESPACES.none,
          "http-equiv",
        )?.toLowerCase() === "refresh")
    ) {
      return true;
    }
    for (const attribute of element.attributes) {
      const isReference =
        xmlNameMatches(attribute, XML_NAMESPACES.xlink, "href") ||
        xmlNameMatches(attribute, XML_NAMESPACES.none, "src") ||
        xmlNameMatches(attribute, XML_NAMESPACES.none, "poster") ||
        xmlNameMatches(attribute, XML_NAMESPACES.none, "data") ||
        xmlNameMatches(attribute, XML_NAMESPACES.none, "background") ||
        xmlNameMatches(attribute, XML_NAMESPACES.none, "action") ||
        xmlNameMatches(attribute, XML_NAMESPACES.none, "formaction") ||
        (xmlNameMatches(attribute, XML_NAMESPACES.none, "href") &&
          !isNavigation);
      if (isReference && isExternalReference(attribute.value)) {
        return true;
      }
      if (
        xmlNameMatches(attribute, XML_NAMESPACES.none, "srcset") &&
        attribute.value
          .split(",")
          .some((candidate) =>
            isExternalReference(candidate.trim().split(/\s/u)[0] ?? ""),
          )
      ) {
        return true;
      }
      if (
        xmlNameMatches(attribute, XML_NAMESPACES.none, "style") &&
        cssHasExternalReference(attribute.value)
      ) {
        return true;
      }
    }
    if (
      element.localName.toLowerCase() === "style" &&
      cssHasExternalReference(element.textContent ?? "")
    ) {
      return true;
    }
    if (
      (xmlNameMatches(element, XML_NAMESPACES.svg, "use") ||
        xmlNameMatches(element, XML_NAMESPACES.svg, "image")) &&
      [...element.attributes].some(
        (attribute) =>
          xmlNameMatches(attribute, XML_NAMESPACES.none, "href") &&
          isExternalReference(attribute.value),
      )
    ) {
      return true;
    }
  }
  return false;
};

const SAFE_FIELD_KEYWORD_VALUES = [
  "PAGE",
  "NUMPAGES",
  "SECTIONPAGES",
  "DATE",
  "TIME",
  "CREATEDATE",
  "SAVEDATE",
  "PRINTDATE",
  "AUTHOR",
  "TITLE",
  "SUBJECT",
  "FILENAME",
  "REF",
  "PAGEREF",
  "NOTEREF",
  "SEQ",
  "TOC",
  "TC",
  "XE",
  "INDEX",
  "STYLEREF",
  "NUMWORDS",
  "NUMCHARS",
  "IF",
  "COMPARE",
  "SET",
  "=",
  "FORMTEXT",
  "FORMCHECKBOX",
  "FORMDROPDOWN",
  "SYMBOL",
  "EQ",
  "ADVANCE",
  "QUOTE",
  "MERGEFIELD",
  "LISTNUM",
  "AUTONUM",
  "AUTONUMLGL",
  "AUTONUMOUT",
  "BIDIOUTLINE",
  "GOTOBUTTON",
  "MACROBUTTON",
  "PRIVATE",
  "ASK",
  "FILLIN",
  "DOCPROPERTY",
  "DOCVARIABLE",
  "INFO",
  "KEYWORDS",
  "COMMENTS",
  "LASTSAVEDBY",
  "TEMPLATE",
  "USERNAME",
  "USERINITIALS",
  "USERADDRESS",
  "REVNUM",
  "EDITTIME",
  "HYPERLINK",
] as const;
type SafeFieldKeyword = (typeof SAFE_FIELD_KEYWORD_VALUES)[number];
const SAFE_FIELD_KEYWORDS: ReadonlySet<string> = new Set<SafeFieldKeyword>(
  SAFE_FIELD_KEYWORD_VALUES,
);

type FieldInstruction = {
  keyword: string | undefined;
  arguments: readonly string[];
};

const parseFieldInstruction = (value: string): FieldInstruction => {
  const tokens = [
    ...value.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/gu),
  ].map(([token]) => token.replace(/^["']|["']$/gu, ""));
  while (tokens.at(0)?.startsWith("\\") === true) {
    tokens.shift();
    if (tokens.at(0)?.startsWith("\\") === false) {
      tokens.shift();
    }
  }
  const keyword = tokens.shift()?.toUpperCase();
  const resourceArguments: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]?.startsWith("\\") === true) {
      if (tokens[index + 1]?.startsWith("\\") === false) {
        index++;
      }
      continue;
    }
    resourceArguments.push(tokens[index] ?? "");
  }
  return { keyword, arguments: resourceArguments };
};

const unsupportedFieldType = (value: string): string | null => {
  const { keyword, arguments: resourceArguments } =
    parseFieldInstruction(value);
  if (keyword === undefined || !SAFE_FIELD_KEYWORDS.has(keyword)) {
    return keyword ?? "UNKNOWN";
  }
  if (
    keyword !== "HYPERLINK" &&
    resourceArguments.some((argument) =>
      isExternalReference(argument.replace(/^["']|["',)]$/gu, "")),
    )
  ) {
    return keyword;
  }
  return null;
};

const fieldInstructionIsRefused = (value: string): boolean =>
  unsupportedFieldType(value) !== null;

const ooxmlUnsupportedField = (source: string): string | null => {
  const document = slimdom.parseXmlDocument(source);
  for (const element of xmlElements(document.documentElement)) {
    if (!xmlNameMatches(element, XML_NAMESPACES.wordprocessing, "fldsimple")) {
      continue;
    }
    const instruction = xmlAttribute(
      element,
      XML_NAMESPACES.wordprocessing,
      "instr",
    );
    const fieldType =
      instruction === null ? "UNKNOWN" : unsupportedFieldType(instruction);
    if (fieldType !== null) {
      return fieldType;
    }
  }
  const instructions: { instruction: string; closed: boolean }[] = [];
  for (const element of xmlElements(document.documentElement)) {
    if (xmlNameMatches(element, XML_NAMESPACES.wordprocessing, "fldchar")) {
      const type = xmlAttribute(
        element,
        XML_NAMESPACES.wordprocessing,
        "fldchartype",
      )?.toLowerCase();
      if (type === "begin") {
        instructions.push({ instruction: "", closed: false });
      } else if (type === "separate") {
        const field = instructions.at(-1);
        if (field !== undefined && !field.closed) {
          const fieldType = unsupportedFieldType(field.instruction);
          if (fieldType !== null) {
            return fieldType;
          }
          field.closed = true;
        }
      } else if (type === "end") {
        const field = instructions.pop();
        if (field !== undefined && !field.closed) {
          const fieldType = unsupportedFieldType(field.instruction);
          if (fieldType !== null) {
            return fieldType;
          }
        }
      }
      continue;
    }
    if (xmlNameMatches(element, XML_NAMESPACES.wordprocessing, "instrtext")) {
      const value = element.textContent ?? "";
      const fieldIndex = instructions.length - 1;
      if (fieldIndex >= 0) {
        const field = instructions[fieldIndex];
        if (field !== undefined && !field.closed) {
          field.instruction += value;
        }
      } else {
        const fieldType = unsupportedFieldType(value);
        if (fieldType !== null) {
          return fieldType;
        }
      }
    }
  }
  for (const { instruction, closed } of instructions) {
    if (!closed) {
      const fieldType = unsupportedFieldType(instruction);
      if (fieldType !== null) {
        return fieldType;
      }
    }
  }
  return null;
};

const isOoxmlInspectedPath = (path: string): boolean => {
  if (path.endsWith(".rels")) {
    return true;
  }
  return path.endsWith(".xml");
};

const isOdfInspectedPath = (path: string): boolean => path.endsWith(".xml");

type PartSize = "body" | "metadata";

type InspectedPart =
  | { kind: "missing" }
  | { kind: "too_large" }
  | { kind: "unsupported_encoding"; encoding: string }
  | { kind: "source"; value: string };

const readInspectedPart = async (
  archive: Awaited<ReturnType<typeof loadDocxArchive>>,
  path: string,
  partSize: PartSize,
): Promise<InspectedPart> => {
  if (partSize === "body") {
    const value = await archive.readEntryUint8(path);
    return value === null ? { kind: "missing" } : decodeText(value);
  }
  const entry = archive.zip.file(path);
  if (entry === null) {
    return { kind: "missing" };
  }
  return await new Promise<InspectedPart>((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer");
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DOCUMENT_METADATA_ENTRY_MAX_BYTES) {
        stream.removeAllListeners("data");
        stream.pause();
        resolve({ kind: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(decodeText(Buffer.concat(chunks, size))));
    stream.on("error", reject);
  });
};

const archiveHas = async (
  bytes: Uint8Array,
  select: (path: string) => boolean,
  partSize: (path: string) => PartSize,
  inspect: (path: string, source: string) => boolean,
): Promise<boolean> => {
  const archive = await loadDocxArchive(bytes);
  const selectedPaths = Object.keys(archive.zip.files).filter(select);
  for (const path of selectedPaths) {
    const part = await readInspectedPart(archive, path, partSize(path));
    switch (part.kind) {
      case "missing":
        break;
      case "too_large":
        return true;
      case "unsupported_encoding":
        return true;
      case "source":
        if (inspect(path, part.value)) {
          return true;
        }
        break;
      default:
        part satisfies never;
        panic("Unexpected inspected part");
    }
  }
  return false;
};

const archiveUnsupportedEncoding = async (
  bytes: Uint8Array,
  format: "ooxml" | "odf",
): Promise<string | null> => {
  const archive = await loadDocxArchive(bytes);
  const selectedPaths = Object.keys(archive.zip.files).filter((path) =>
    format === "ooxml" ? isOoxmlInspectedPath(path) : isOdfInspectedPath(path),
  );
  for (const path of selectedPaths) {
    const part = await readInspectedPart(
      archive,
      path,
      path.endsWith(".rels") || path === "styles.xml" ? "metadata" : "body",
    );
    if (part.kind === "unsupported_encoding") {
      return part.encoding;
    }
  }
  return null;
};

const archiveCatchAllRefusal = async (
  bytes: Uint8Array,
  mime: ConvertibleMime,
  format: "ooxml" | "odf",
  referenceAllowlist: ReferenceAllowlist,
): Promise<ReferenceRefusal | null> => {
  const archive = await loadDocxArchive(bytes);
  const selectedPaths = Object.keys(archive.zip.files).filter((path) =>
    format === "ooxml" ? isOoxmlInspectedPath(path) : isOdfInspectedPath(path),
  );
  for (const path of selectedPaths) {
    const part = await readInspectedPart(
      archive,
      path,
      path.endsWith(".rels") || path === "styles.xml" ? "metadata" : "body",
    );
    if (part.kind !== "source") {
      continue;
    }
    const refusal = xmlCatchAllRefusal(
      part.value,
      mime,
      format,
      referenceAllowlist,
    );
    if (refusal !== null) {
      return refusal;
    }
  }
  return null;
};

const ooxmlHasExternalReference = async (bytes: Uint8Array): Promise<boolean> =>
  await archiveHas(
    bytes,
    isOoxmlInspectedPath,
    (path) => (path.endsWith(".rels") ? "metadata" : "body"),
    (path, source) =>
      path.endsWith(".rels") && relationshipHasExternalReference(source),
  );

const ooxmlUnsupportedFieldType = async (
  bytes: Uint8Array,
): Promise<string | null> => {
  const archive = await loadDocxArchive(bytes);
  const paths = Object.keys(archive.zip.files).filter(
    (path) => isOoxmlInspectedPath(path) && !path.endsWith(".rels"),
  );
  for (const path of paths) {
    const part = await readInspectedPart(archive, path, "body");
    if (part.kind === "too_large") {
      return "UNKNOWN";
    }
    if (part.kind === "source") {
      const fieldType = ooxmlUnsupportedField(part.value);
      if (fieldType !== null) {
        return fieldType;
      }
    }
  }
  return null;
};

const odfHasExternalReference = async (bytes: Uint8Array): Promise<boolean> =>
  await archiveHas(
    bytes,
    isOdfInspectedPath,
    (path) => (path === "styles.xml" ? "metadata" : "body"),
    (_path, source) => {
      const document = slimdom.parseXmlDocument(source);
      for (const element of xmlElements(document.documentElement)) {
        if (xmlNameMatches(element, XML_NAMESPACES.text, "a")) {
          continue;
        }
        const href = xmlAttribute(element, XML_NAMESPACES.xlink, "href");
        if (href !== null && isExternalReference(href)) {
          return true;
        }
      }
      return false;
    },
  );

type RtfDecodeResult = { value: string; end: number } | null;

const rtfGroupEnd = (source: string, start: number): number | null => {
  let cursor = start + 1;
  let depth = 1;
  while (cursor < source.length && depth > 0) {
    if (source[cursor] === "\\") {
      cursor += source[cursor + 1] === "'" ? 4 : 2;
      continue;
    }
    if (source[cursor] === "{") {
      depth++;
    }
    if (source[cursor] === "}") {
      depth--;
    }
    cursor++;
  }
  return depth === 0 ? cursor : null;
};

type RtfDestination = { name: string; contentStart: number };

const rtfDestinationAt = (
  source: string,
  groupStart: number,
): RtfDestination | null => {
  let cursor = groupStart + 1;
  while (source[cursor] === "\r" || source[cursor] === "\n") {
    cursor++;
  }
  if (source[cursor] !== "\\") {
    return null;
  }
  cursor++;
  if (source[cursor] === "*") {
    cursor++;
    while (source[cursor] === "\r" || source[cursor] === "\n") {
      cursor++;
    }
    if (source[cursor] !== "\\") {
      return null;
    }
    cursor++;
  }
  const wordStart = cursor;
  while (/[a-z]/iu.test(source[cursor] ?? "")) {
    cursor++;
  }
  if (cursor === wordStart) {
    return null;
  }
  const name = source.slice(wordStart, cursor).toLowerCase();
  if (source[cursor] === "-") {
    cursor++;
  }
  while (/\d/u.test(source[cursor] ?? "")) {
    cursor++;
  }
  if (source[cursor] === " ") {
    cursor++;
  } else {
    while (source[cursor] === "\r" || source[cursor] === "\n") {
      cursor++;
    }
  }
  return { name, contentStart: cursor };
};

const rtfUnicodeCodePoint = (signed: number): number =>
  signed < 0 ? signed + 65_536 : signed;

const decodeRtfInstruction = (
  source: string,
  start: number,
): RtfDecodeResult => {
  let cursor = start;
  let value = "";
  let fallbackLength = 1;
  let fallbackRemaining = 0;
  let depth = 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "{") {
      if (source.startsWith("{\\*", cursor)) {
        const destinationEnd = rtfGroupEnd(source, cursor);
        if (destinationEnd === null) {
          return null;
        }
        cursor = destinationEnd;
        continue;
      }
      depth++;
      cursor++;
      continue;
    }
    if (character === "}") {
      depth--;
      cursor++;
      if (depth === 0) {
        return { value, end: cursor };
      }
      continue;
    }
    if (character !== "\\") {
      if (fallbackRemaining > 0) {
        fallbackRemaining--;
      } else {
        value += character;
      }
      cursor++;
      continue;
    }
    cursor++;
    const symbol = source[cursor];
    if (symbol === undefined) {
      return null;
    }
    if (symbol === "'") {
      const hex = source.slice(cursor + 1, cursor + 3);
      if (!/^[\da-f]{2}$/iu.test(hex)) {
        return null;
      }
      if (fallbackRemaining > 0) {
        fallbackRemaining--;
      } else {
        value += latin1(new Uint8Array([Number.parseInt(hex, 16)]));
      }
      cursor += 3;
      continue;
    }
    if (symbol === "\\" || symbol === "{" || symbol === "}") {
      if (fallbackRemaining > 0) {
        fallbackRemaining--;
      } else {
        value += symbol;
      }
      cursor++;
      continue;
    }
    if (!/[a-z]/iu.test(symbol)) {
      cursor++;
      continue;
    }
    const wordStart = cursor;
    while (/[a-z]/iu.test(source[cursor] ?? "")) {
      cursor++;
    }
    const word = source.slice(wordStart, cursor).toLowerCase();
    const parameterStart = cursor;
    if (source[cursor] === "-") {
      cursor++;
    }
    while (/\d/u.test(source[cursor] ?? "")) {
      cursor++;
    }
    const parameterSource = source.slice(parameterStart, cursor);
    if (source[cursor] === " ") {
      cursor++;
    }
    if (word === "uc") {
      if (!/^\d+$/u.test(parameterSource)) {
        return null;
      }
      fallbackLength = Number.parseInt(parameterSource, 10);
    } else if (word === "u") {
      if (!/^-?\d+$/u.test(parameterSource)) {
        return null;
      }
      const signed = Number.parseInt(parameterSource, 10);
      if (signed < -32_768 || signed > 32_767) {
        return null;
      }
      value += String.fromCodePoint(rtfUnicodeCodePoint(signed));
      fallbackRemaining = fallbackLength;
    }
  }
  return null;
};

const rtfHasExternalReference = (source: string): boolean => {
  const lower = source.toLowerCase();
  if (lower.includes("\\objlink")) {
    return true;
  }
  for (let cursor = 0; cursor < source.length; cursor++) {
    if (source[cursor] !== "{") {
      continue;
    }
    const destination = rtfDestinationAt(source, cursor);
    if (destination === null) {
      continue;
    }
    if (destination.name === "field" && rtfGroupEnd(source, cursor) === null) {
      return true;
    }
    if (destination.name !== "fldinst") {
      continue;
    }
    const decoded = decodeRtfInstruction(source, destination.contentStart);
    if (decoded === null || fieldInstructionIsRefused(decoded.value)) {
      return true;
    }
  }
  return false;
};

class LegacyWordParseError extends TaggedError("LegacyWordParseError")<{
  message: string;
}> {}

const legacyWordError = (message: string): LegacyWordParseError =>
  new LegacyWordParseError({ message });

const checkedView = (
  bytes: Uint8Array,
  offset: number,
  length: number,
): Result<DataView, LegacyWordParseError> =>
  offset < 0 || length < 0 || offset + length > bytes.byteLength
    ? Result.err(legacyWordError("Legacy Word structure is out of bounds"))
    : Result.ok(new DataView(bytes.buffer, bytes.byteOffset + offset, length));

type WordPiece = {
  cpStart: number;
  cpEnd: number;
  offset: number;
  wide: boolean;
};

const readWordPieces = (
  word: Uint8Array,
  table: Uint8Array,
): Result<WordPiece[], LegacyWordParseError> =>
  Result.gen(function* () {
    const fib = yield* checkedView(word, 0, 426);
    if (fib.getUint16(0, true) !== 0xa5_ec) {
      return Result.err(legacyWordError("Legacy Word FIB is invalid"));
    }
    const fcClx = fib.getUint32(418, true);
    const lcbClx = fib.getUint32(422, true);
    if (lcbClx < 5 || fcClx + lcbClx > table.byteLength) {
      return Result.err(legacyWordError("Legacy Word CLX is out of bounds"));
    }
    let cursor = fcClx;
    const clxEnd = fcClx + lcbClx;
    while (cursor < clxEnd && table[cursor] === 1) {
      const prc = yield* checkedView(table, cursor, 3);
      cursor += 3 + prc.getUint16(1, true);
    }
    const pcdt = yield* checkedView(table, cursor, 5);
    if (pcdt.getUint8(0) !== 2) {
      return Result.err(legacyWordError("Legacy Word piece table is missing"));
    }
    const plcBytes = pcdt.getUint32(1, true);
    cursor += 5;
    if (
      plcBytes < 4 ||
      (plcBytes - 4) % 12 !== 0 ||
      cursor + plcBytes > clxEnd
    ) {
      return Result.err(legacyWordError("Legacy Word piece table is invalid"));
    }
    const pieceCount = (plcBytes - 4) / 12;
    const plc = yield* checkedView(table, cursor, plcBytes);
    const pieces: WordPiece[] = [];
    for (let index = 0; index < pieceCount; index++) {
      const cpStart = plc.getUint32(index * 4, true);
      const cpEnd = plc.getUint32((index + 1) * 4, true);
      const pcdOffset = (pieceCount + 1) * 4 + index * 8;
      const encodedOffset = plc.getUint32(pcdOffset + 2, true);
      const wide = Math.floor(encodedOffset / 0x40_00_00_00) % 2 === 0;
      const offset = wide
        ? encodedOffset % 0x40_00_00_00
        : (encodedOffset % 0x40_00_00_00) / 2;
      const byteLength = (cpEnd - cpStart) * (wide ? 2 : 1);
      if (
        cpEnd < cpStart ||
        !Number.isInteger(offset) ||
        offset + byteLength > word.byteLength
      ) {
        return Result.err(
          legacyWordError("Legacy Word text piece is out of bounds"),
        );
      }
      pieces.push({ cpStart, cpEnd, offset, wide });
    }
    return Result.ok(pieces);
  });

const wordRangeText = (
  word: Uint8Array,
  pieces: readonly WordPiece[],
  rangeStart: number,
  rangeEnd: number,
): Result<string, LegacyWordParseError> => {
  let value = "";
  let coveredUntil = rangeStart;
  for (const piece of pieces) {
    const start = Math.max(rangeStart, piece.cpStart);
    const end = Math.min(rangeEnd, piece.cpEnd);
    if (start >= end) {
      continue;
    }
    if (start !== coveredUntil) {
      return Result.err(legacyWordError("Legacy Word text range has a gap"));
    }
    const unit = piece.wide ? 2 : 1;
    const offset = piece.offset + (start - piece.cpStart) * unit;
    const bytes = word.subarray(offset, offset + (end - start) * unit);
    value += piece.wide
      ? new TextDecoder("utf-16le").decode(bytes)
      : latin1(bytes);
    coveredUntil = end;
  }
  return coveredUntil === rangeEnd
    ? Result.ok(value)
    : Result.err(legacyWordError("Legacy Word text range is incomplete"));
};

const unsupportedFieldInText = (
  source: string,
): Result<string | null, LegacyWordParseError> => {
  const stack: { instruction: string; separated: boolean }[] = [];
  for (const character of source) {
    if (character === "\u0013") {
      stack.push({ instruction: "", separated: false });
      continue;
    }
    if (character === "\u0014" || character === "\u0015") {
      const field = stack.at(-1);
      if (!field) {
        continue;
      }
      if (!field.separated) {
        const fieldType = unsupportedFieldType(field.instruction);
        if (fieldType !== null) {
          return Result.ok(fieldType);
        }
        field.separated = true;
      }
      if (character === "\u0015") {
        stack.pop();
      }
      continue;
    }
    for (const field of stack) {
      if (!field.separated) {
        field.instruction += character;
      }
    }
  }
  return stack.length === 0
    ? Result.ok(null)
    : Result.err(legacyWordError("Legacy Word field is unfinished"));
};

const docUnsupportedFieldType = (
  bytes: Uint8Array,
): Result<string | null, LegacyWordParseError> =>
  Result.gen(function* () {
    const file = yield* CompoundFile.parse(bytes).mapError((error) =>
      legacyWordError(error.message),
    );
    const wordEntry = file.streamEntries.find(
      ({ path }) => path.length === 1 && path[0] === "WordDocument",
    );
    if (!wordEntry) {
      return Result.err(
        legacyWordError("Legacy Word document stream is missing"),
      );
    }
    const word = yield* file
      .readStream(wordEntry.entry)
      .mapError((error) => legacyWordError(error.message));
    const fib = yield* checkedView(word, 0, 426);
    const tableName =
      Math.floor(fib.getUint16(10, true) / 0x02_00) % 2 === 0
        ? "0Table"
        : "1Table";
    const tableEntry = file.streamEntries.find(
      ({ path }) => path.length === 1 && path[0] === tableName,
    );
    if (!tableEntry) {
      return Result.err(legacyWordError("Legacy Word table stream is missing"));
    }
    const table = yield* file
      .readStream(tableEntry.entry)
      .mapError((error) => legacyWordError(error.message));
    const pieces = yield* readWordPieces(word, table);
    let cp = 0;
    for (const offset of [76, 80, 84, 88, 92, 96, 100, 104]) {
      const length = fib.getUint32(offset, true);
      if (length === 0) {
        continue;
      }
      const range = yield* wordRangeText(word, pieces, cp, cp + length);
      const fieldType = yield* unsupportedFieldInText(range);
      if (fieldType !== null) {
        return Result.ok(fieldType);
      }
      cp += length;
    }
    return Result.ok(null);
  });
const safe = (): false => false;

const DETECTORS = {
  "application/msword": safe,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ooxmlHasExternalReference,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    ooxmlHasExternalReference,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ooxmlHasExternalReference,
  "application/vnd.ms-excel": safe,
  "application/vnd.ms-powerpoint": safe,
  "application/vnd.oasis.opendocument.presentation": odfHasExternalReference,
  "application/vnd.oasis.opendocument.spreadsheet": odfHasExternalReference,
  "application/vnd.oasis.opendocument.text": odfHasExternalReference,
  "application/rtf": safe,
  "application/vnd.apple.pages": safe,
  "application/xhtml+xml": safe,
  "image/bmp": safe,
  "image/gif": safe,
  "image/jpeg": safe,
  "image/png": safe,
  "image/tiff": safe,
  "image/webp": safe,
  "text/csv": safe,
  "text/html": safe,
  "text/plain": safe,
} as const satisfies Record<ConvertibleMime, Detector>;

type PreparedInputText = DecodedText | { kind: "binary" };

const archiveMarkupFormat = (mime: ConvertibleMime): "ooxml" | "odf" | null => {
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "ooxml";
  }
  if (
    mime === "application/vnd.oasis.opendocument.presentation" ||
    mime === "application/vnd.oasis.opendocument.spreadsheet" ||
    mime === "application/vnd.oasis.opendocument.text"
  ) {
    return "odf";
  }
  return null;
};

const prepareInputText = async (
  mime: ConvertibleMime,
  bytes: Uint8Array,
): Promise<PreparedInputText> => {
  if (
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    mime === "application/rtf"
  ) {
    return decodeText(bytes);
  }
  const archiveFormat = archiveMarkupFormat(mime);
  if (archiveFormat === null) {
    return { kind: "binary" };
  }
  const encoding = await archiveUnsupportedEncoding(bytes, archiveFormat);
  return encoding === null
    ? { kind: "binary" }
    : { kind: "unsupported_encoding", encoding };
};

const decodedTextHasExternalReference = (
  mime: ConvertibleMime,
  source: string | null,
): boolean => {
  if (mime === "text/html") {
    return htmlHasExternalReference(source ?? "");
  }
  if (mime === "application/xhtml+xml") {
    return xhtmlHasExternalReference(source ?? "");
  }
  return mime === "application/rtf"
    ? rtfHasExternalReference(source ?? "")
    : false;
};

export const checkConversionInput = async (
  mime: ConvertibleMime,
  bytes: Uint8Array,
  referenceAllowlist: ReferenceAllowlist = REFERENCE_ALLOWLIST,
): Promise<ConversionInputResult> => {
  const prepared = await prepareInputText(mime, bytes);
  if (prepared.kind === "unsupported_encoding") {
    return { kind: "refuse", format: mime, reason: prepared };
  }
  const decodedSource = prepared.kind === "source" ? prepared.value : null;
  if (mime === "application/vnd.ms-excel") {
    return {
      kind: "refuse",
      format: mime,
      reason: { kind: "legacy_format", replacementExtension: ".xlsx" },
    };
  }
  if (mime === "application/vnd.ms-powerpoint") {
    return {
      kind: "refuse",
      format: mime,
      reason: { kind: "legacy_format", replacementExtension: ".pptx" },
    };
  }
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    const fieldType = await ooxmlUnsupportedFieldType(bytes);
    if (fieldType !== null) {
      return {
        kind: "refuse",
        format: mime,
        reason: { kind: "unsupported_field", fieldType },
      };
    }
  }
  if (mime === "application/msword") {
    const fieldType = docUnsupportedFieldType(bytes);
    if (Result.isError(fieldType)) {
      return {
        kind: "refuse",
        format: mime,
        reason: { kind: "inspection_failed" },
      };
    }
    if (fieldType.value !== null) {
      return {
        kind: "refuse",
        format: mime,
        reason: { kind: "unsupported_field", fieldType: fieldType.value },
      };
    }
  }
  if (mime === "text/html") {
    const styleRefusal = htmlStyleAttributeRefusal(decodedSource ?? "", mime);
    if (styleRefusal !== null) {
      return { kind: "refuse", format: mime, reason: styleRefusal };
    }
  }
  if (decodedTextHasExternalReference(mime, decodedSource)) {
    return {
      kind: "refuse",
      reason: { kind: "external_reference" },
      format: mime,
    };
  }
  if (await DETECTORS[mime](bytes)) {
    return {
      kind: "refuse",
      reason: { kind: "external_reference" },
      format: mime,
    };
  }
  let catchAllRefusal: ReferenceRefusal | null = null;
  if (mime === "text/html") {
    catchAllRefusal = htmlCatchAllRefusal(
      decodedSource ?? "",
      mime,
      referenceAllowlist,
    );
  } else if (mime === "application/xhtml+xml") {
    catchAllRefusal = xmlCatchAllRefusal(
      decodedSource ?? "",
      mime,
      "xhtml",
      referenceAllowlist,
    );
  } else if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    catchAllRefusal = await archiveCatchAllRefusal(
      bytes,
      mime,
      "ooxml",
      referenceAllowlist,
    );
  } else if (
    mime === "application/vnd.oasis.opendocument.presentation" ||
    mime === "application/vnd.oasis.opendocument.spreadsheet" ||
    mime === "application/vnd.oasis.opendocument.text"
  ) {
    catchAllRefusal = await archiveCatchAllRefusal(
      bytes,
      mime,
      "odf",
      referenceAllowlist,
    );
  }
  return catchAllRefusal === null
    ? { kind: "convert" }
    : { kind: "refuse", format: mime, reason: catchAllRefusal };
};
