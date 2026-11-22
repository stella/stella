import { Result } from "better-result";

import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import type { DocumentPackageError } from "@/api/lib/files/document-archive";
import {
  createDocumentText,
  documentPackageError,
  type DocumentXmlNode,
  parseStandaloneXml,
} from "@/api/lib/files/xml-document-package";

/**
 * An XML document as readable text: its elements indented one level per
 * nesting depth, with their attributes and text, cut at `maxChars`. Namespace
 * declarations are left out; element names are shown without their prefixes.
 */

const INDENT = "  ";

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

const formatNode = (
  node: DocumentXmlNode,
  depth: number,
  append: (part: string) => void,
) => {
  const indent = INDENT.repeat(depth);
  const text = node.text.replace(/\s+/gu, " ").trim();
  if (node.children.length === 0) {
    append(
      text
        ? `${indent}<${openTag(node)}>${escapeText(text)}</${node.localName}>\n`
        : `${indent}<${openTag(node)}/>\n`,
    );
    return;
  }
  append(`${indent}<${openTag(node)}>\n`);
  if (text) {
    append(`${indent}${INDENT}${escapeText(text)}\n`);
  }
  for (const child of node.children) {
    formatNode(child, depth + 1, append);
  }
  append(`${indent}</${node.localName}>\n`);
};

const formatXmlDocument = (root: DocumentXmlNode, maxChars: number) => {
  const document = createDocumentText(maxChars);
  formatNode(root, 0, document.append);
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
  const decoded = Result.try(() =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (decoded.isErr()) {
    return Result.err(
      documentPackageError("The XML file is not readable text"),
    );
  }
  const raw = createDocumentText(maxChars);
  raw.append(decoded.value);
  return raw.finish();
};
