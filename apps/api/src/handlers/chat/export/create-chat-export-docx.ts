import { panic } from "better-result";
import JSZip from "jszip";

import type { Footnote, ParagraphContent } from "@stll/docx-core/model";
import type { Document } from "@stll/folio-core";

import { documentToDocx } from "@/api/lib/docx-authoring/document";

const CONTENT_TYPES_PATH = "[Content_Types].xml";
const DOCUMENT_RELATIONSHIPS_PATH = "word/_rels/document.xml.rels";
const FOOTNOTES_PATH = "word/footnotes.xml";
const FOOTNOTES_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml";
const FOOTNOTES_RELATIONSHIP_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes";

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const textFromParagraphContent = (content: ParagraphContent): string => {
  if (content.type !== "run") {
    return panic("Chat-export footnotes must contain plain-text runs");
  }
  let text = "";
  for (const item of content.content) {
    if (item.type !== "text") {
      return panic("Chat-export footnote runs must contain only text");
    }
    text += item.text;
  }
  return text;
};

const textFromFootnote = (footnote: Footnote): string => {
  const paragraph = footnote.content.at(0);
  if (
    footnote.content.length !== 1 ||
    paragraph?.type !== "paragraph" ||
    paragraph.content.length === 0
  ) {
    return panic("Chat-export footnotes must contain one text paragraph");
  }
  return paragraph.content.map(textFromParagraphContent).join("");
};

const serializeFootnote = (footnote: Footnote): string => {
  const text = escapeXml(textFromFootnote(footnote));
  return [
    `<w:footnote w:id="${footnote.id}"><w:p>`,
    '<w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>',
    '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>',
    "<w:footnoteRef/></w:r>",
    "<w:r><w:tab/></w:r>",
    `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`,
    "</w:p></w:footnote>",
  ].join("");
};

const serializeFootnotes = (footnotes: readonly Footnote[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>',
    '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>',
    footnotes.map(serializeFootnote).join(""),
    "</w:footnotes>",
  ].join("");

const requiredZipText = async (zip: JSZip, path: string): Promise<string> => {
  const file = zip.file(path);
  if (file === null) {
    return panic(`Generated DOCX is missing ${path}`);
  }
  return await file.async("text");
};

const appendBeforeClosingTag = (
  xml: string,
  closingTag: string,
  content: string,
): string => {
  if (!xml.includes(closingTag)) {
    return panic(`Generated DOCX is missing ${closingTag}`);
  }
  return xml.replace(closingTag, () => `${content}${closingTag}`);
};

const nextRelationshipId = (relationshipsXml: string): string => {
  let maximumId = 0;
  for (const match of relationshipsXml.matchAll(/\bId="rId(?<id>\d+)"/gu)) {
    const id = Number(match.groups?.["id"]);
    if (Number.isSafeInteger(id)) {
      maximumId = Math.max(maximumId, id);
    }
  }
  return `rId${maximumId + 1}`;
};

/**
 * Serialize a styled chat export and add the standard OOXML footnote package
 * parts that Folio deliberately preserves, but does not create, during save.
 */
export const createChatExportDocx = async (
  document: Document,
): Promise<ArrayBuffer> => {
  const bytes = await documentToDocx(document);
  const footnotes = document.package.footnotes;
  if (footnotes === undefined || footnotes.length === 0) {
    return bytes;
  }

  const zip = await JSZip.loadAsync(bytes);
  const contentTypes = await requiredZipText(zip, CONTENT_TYPES_PATH);
  const relationships = await requiredZipText(zip, DOCUMENT_RELATIONSHIPS_PATH);
  const relationshipId = nextRelationshipId(relationships);

  zip.file(
    CONTENT_TYPES_PATH,
    appendBeforeClosingTag(
      contentTypes,
      "</Types>",
      `<Override PartName="/${FOOTNOTES_PATH}" ContentType="${FOOTNOTES_CONTENT_TYPE}"/>`,
    ),
  );
  zip.file(
    DOCUMENT_RELATIONSHIPS_PATH,
    appendBeforeClosingTag(
      relationships,
      "</Relationships>",
      `<Relationship Id="${relationshipId}" Type="${FOOTNOTES_RELATIONSHIP_TYPE}" Target="footnotes.xml"/>`,
    ),
  );
  zip.file(FOOTNOTES_PATH, serializeFootnotes(footnotes));

  return await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
};
