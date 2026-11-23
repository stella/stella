import { Result } from "better-result";

import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import type { DocumentPackageError } from "@/api/lib/files/document-archive";
import {
  createDocumentText,
  documentPackageError,
  type DocumentXmlNode,
  parseStandaloneXml,
  xmlEncoding,
} from "@/api/lib/files/xml-document-package";

/**
 * An XML document as readable text: its elements indented one level per
 * nesting depth, with their attributes and text in document order, cut at
 * `maxChars`. Namespace declarations are left out; element names are shown
 * without their prefixes. Whitespace in text is collapsed, except under
 * `xml:space="preserve"`, which an element's descendants inherit.
 */

const INDENT = "  ";

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const DELETE = 0x7f;

/** C0 controls other than tab, line feed and carriage return, and DEL. */
const holdsBinaryControl = (text: string) => {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code === DELETE ||
      (code < 0x20 &&
        code !== TAB &&
        code !== LINE_FEED &&
        code !== CARRIAGE_RETURN)
    ) {
      return true;
    }
  }
  return false;
};

const escapeText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

const escapeAttribute = (value: string) =>
  escapeText(value).replaceAll('"', "&quot;");

const openTag = (node: DocumentXmlNode) => {
  const attributes = [...node.attributes]
    .filter(([name]) => name !== "xmlns" && !name.startsWith("xmlns:"))
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  return `${node.localName}${attributes}`;
};

/** Whether an element keeps its text's whitespace, as `xml:space` says. */
const preservesSpace = (node: DocumentXmlNode, inherited: boolean) => {
  const declared = node.attributes.get("xml:space");
  return declared === undefined ? inherited : declared === "preserve";
};

const readableText = (run: string, preserve: boolean) =>
  preserve ? run : run.replace(/\s+/gu, " ").trim();

const formatNode = (
  node: DocumentXmlNode,
  depth: number,
  inheritedPreserve: boolean,
  append: (part: string) => void,
) => {
  const indent = INDENT.repeat(depth);
  const preserve = preservesSpace(node, inheritedPreserve);
  if (node.children.length === 0) {
    const text = readableText(node.text, preserve);
    append(
      text.trim()
        ? `${indent}<${openTag(node)}>${escapeText(text)}</${node.localName}>\n`
        : `${indent}<${openTag(node)}/>\n`,
    );
    return;
  }
  append(`${indent}<${openTag(node)}>\n`);
  // Text runs and child elements in the order the document has them, so
  // mixed content reads as written.
  for (const part of node.content) {
    if (typeof part !== "string") {
      formatNode(part, depth + 1, preserve, append);
      continue;
    }
    const text = readableText(part, preserve);
    if (text.trim()) {
      append(`${indent}${INDENT}${escapeText(text)}\n`);
    }
  }
  append(`${indent}</${node.localName}>\n`);
};

const formatXmlDocument = (root: DocumentXmlNode, maxChars: number) => {
  const document = createDocumentText(maxChars);
  formatNode(root, 0, false, document.append);
  return document.finish();
};

/**
 * An XML file's readable text. A document the bounded parser refuses (a
 * document type declaration, malformed markup) is shown as the text it holds,
 * as long as it is text at all.
 */
export const readXmlDocumentText = (
  bytes: Uint8Array,
  maxChars: number,
): Result<{ text: string; truncated: boolean }, DocumentPackageError> => {
  const root = parseStandaloneXml(bytes, DOCUMENT_ARCHIVE_MAX_BYTES);
  if (root.isOk()) {
    return formatXmlDocument(root.value, maxChars);
  }
  // The encoding the parser reads (a byte-order mark, a declared legacy
  // encoding, else UTF-8), and markup only: text that does not open with a
  // tag, or holds control characters, is not an XML document.
  const decoded = Result.try(() =>
    new TextDecoder(xmlEncoding(bytes), { fatal: true }).decode(bytes),
  );
  if (
    decoded.isErr() ||
    !decoded.value.trimStart().startsWith("<") ||
    holdsBinaryControl(decoded.value)
  ) {
    return Result.err(
      documentPackageError("The XML file is not readable text"),
    );
  }
  const raw = createDocumentText(maxChars);
  raw.append(decoded.value);
  return raw.finish();
};
