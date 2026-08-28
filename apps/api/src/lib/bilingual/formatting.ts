import { TaggedError } from "better-result";
import * as slimdom from "slimdom";

import type { StoredRow } from "@/api/lib/bilingual/operations";
import type { BilingualUnit } from "@/api/lib/bilingual/rows";
import { loadDocxArchive } from "@/api/lib/docx-archive";

const DOCUMENT_PART = "word/document.xml";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const INLINE_SEPARATOR = " / ";

export type BilingualTextSpan = Readonly<{
  id: string;
  text: string;
}>;

export type BilingualInlineControl = Readonly<{
  type: "control";
  kind: "break" | "field" | "fieldInstruction" | "symbol" | "tab";
}>;

export type BilingualInlineToken =
  | (BilingualTextSpan & Readonly<{ type: "text" }>)
  | BilingualInlineControl;

export type FormattedBilingualUnit = BilingualUnit & {
  inline: readonly BilingualInlineToken[];
  spans: readonly BilingualTextSpan[];
};

export type BilingualFormattedTranslation = Readonly<{
  text: string;
  spans: readonly BilingualTextSpan[];
}>;

type BilingualFormattingErrorReason =
  | "invalid-spans"
  | "malformed-xml"
  | "missing-document"
  | "missing-paragraph";

export class BilingualFormattingError extends TaggedError(
  "BilingualFormattingError",
)<{
  message: string;
  reason: BilingualFormattingErrorReason;
}> {}

const fail = (
  reason: BilingualFormattingErrorReason,
  message: string,
): never => {
  throw new BilingualFormattingError({ message, reason });
};

const isElement = (node: slimdom.Node): node is slimdom.Element =>
  node.nodeType === node.ELEMENT_NODE;

const isWordElement = (node: slimdom.Node, localName: string): boolean =>
  isElement(node) && node.namespaceURI === W_NS && node.localName === localName;

const paragraphById = (
  doc: slimdom.Document,
): ReadonlyMap<string, slimdom.Element> => {
  const result = new Map<string, slimdom.Element>();
  for (const paragraph of doc.getElementsByTagNameNS(W_NS, "p")) {
    const paraId = paragraph.getAttributeNS(W14_NS, "paraId");
    if (paraId !== null) {
      result.set(paraId, paragraph);
    }
  }
  return result;
};

const controlKind = (
  element: slimdom.Element,
): BilingualInlineControl["kind"] | null => {
  switch (element.localName) {
    case "br":
      return "break";
    case "fldChar":
      return "field";
    case "instrText":
      return "fieldInstruction";
    case "sym":
      return "symbol";
    case "ptab":
    case "tab":
      return "tab";
    default:
      return null;
  }
};

type ParagraphProjection = Readonly<{
  inline: readonly BilingualInlineToken[];
  spans: readonly BilingualTextSpan[];
  textNodes: readonly slimdom.Element[];
}>;

const projectParagraph = (
  paragraph: slimdom.Element,
  rowId: string,
): ParagraphProjection => {
  const inline: BilingualInlineToken[] = [];
  const spans: BilingualTextSpan[] = [];
  const textNodes: slimdom.Element[] = [];
  const walk = (node: slimdom.Node): void => {
    if (node !== paragraph && isWordElement(node, "p")) {
      return;
    }
    if (isElement(node)) {
      if (isWordElement(node, "delText")) {
        return;
      }
      if (isWordElement(node, "t")) {
        const id = `${rowId}:s${String(spans.length + 1).padStart(4, "0")}`;
        const text = node.textContent ?? "";
        const span = Object.freeze({ id, text });
        spans.push(span);
        inline.push(Object.freeze({ type: "text" as const, ...span }));
        textNodes.push(node);
        return;
      }
      if (node.namespaceURI === W_NS) {
        const kind = controlKind(node);
        if (kind !== null) {
          inline.push(Object.freeze({ type: "control" as const, kind }));
          if (kind === "fieldInstruction") {
            return;
          }
        }
      }
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };
  walk(paragraph);
  return Object.freeze({
    inline: Object.freeze(inline),
    spans: Object.freeze(spans),
    textNodes: Object.freeze(textNodes),
  });
};

const parseDocumentPart = (xml: string): slimdom.Document => {
  try {
    return slimdom.parseXmlDocument(xml);
  } catch {
    return fail("malformed-xml", "Bilingual DOCX has malformed document XML");
  }
};

const loadDocumentPart = async (buffer: ArrayBuffer) => {
  const archive = await loadDocxArchive(buffer);
  const xml = await archive.readEntryString(DOCUMENT_PART);
  if (xml === null) {
    return fail(
      "missing-document",
      "Bilingual DOCX is missing word/document.xml",
    );
  }
  return { archive, doc: parseDocumentPart(xml) };
};

/**
 * Project each editable bilingual paragraph into ordered text spans plus
 * immutable inline controls. The model translates the spans; tabs, breaks,
 * symbols, and fields never cross the model boundary as editable content.
 */
export const extractFormattedBilingualUnits = async (
  buffer: ArrayBuffer,
  units: readonly BilingualUnit[],
): Promise<FormattedBilingualUnit[]> => {
  const { doc } = await loadDocumentPart(buffer);
  const paragraphs = paragraphById(doc);
  return units.map((unit) => {
    const paragraph = paragraphs.get(unit.rowId);
    if (!paragraph) {
      return fail(
        "missing-paragraph",
        `Bilingual row ${unit.rowId} has no matching paragraph`,
      );
    }
    const { inline, spans } = projectParagraph(paragraph, unit.rowId);
    return { ...unit, inline, spans };
  });
};

const validateTranslationSpans = (
  rowId: string,
  source: ParagraphProjection,
  translation: BilingualFormattedTranslation,
): void => {
  if (source.spans.length !== translation.spans.length) {
    fail(
      "invalid-spans",
      `Translation for ${rowId} has ${translation.spans.length} spans; expected ${source.spans.length}`,
    );
  }
  if (
    translation.text !== translation.spans.map((span) => span.text).join("")
  ) {
    fail(
      "invalid-spans",
      `Translation for ${rowId} has text that differs from its spans`,
    );
  }
  for (const [index, sourceSpan] of source.spans.entries()) {
    if (translation.spans.at(index)?.id !== sourceSpan.id) {
      fail(
        "invalid-spans",
        `Translation for ${rowId} has missing, duplicate, or reordered spans`,
      );
    }
  }
};

const replaceText = (
  rowId: string,
  paragraph: slimdom.Element,
  translation: BilingualFormattedTranslation,
): void => {
  const source = projectParagraph(paragraph, rowId);
  validateTranslationSpans(rowId, source, translation);
  for (const [index, node] of source.textNodes.entries()) {
    const span = translation.spans.at(index);
    if (!span) {
      return fail(
        "invalid-spans",
        `Translation for ${rowId} has no span ${index + 1}`,
      );
    }
    const { text } = span;
    node.textContent = text;
    if (/^\s|\s$/u.test(text)) {
      node.setAttributeNS(XML_NS, "xml:space", "preserve");
    }
  }
};

const createSeparatorRun = (doc: slimdom.Document): slimdom.Element => {
  const run = doc.createElementNS(W_NS, "w:r");
  const text = doc.createElementNS(W_NS, "w:t");
  text.setAttributeNS(XML_NS, "xml:space", "preserve");
  text.textContent = INLINE_SEPARATOR;
  run.append(text);
  return run;
};

const appendInlineContent = (
  doc: slimdom.Document,
  source: slimdom.Element,
  translated: slimdom.Element,
): void => {
  source.append(createSeparatorRun(doc));
  for (const child of [...translated.childNodes]) {
    if (isWordElement(child, "pPr")) {
      continue;
    }
    source.append(child.cloneNode(true));
  }
};

const applyRow = (
  doc: slimdom.Document,
  paragraphs: ReadonlyMap<string, slimdom.Element>,
  row: StoredRow,
  translation: BilingualFormattedTranslation,
): void => {
  const target = paragraphs.get(row.rowId);
  if (!target) {
    return fail(
      "missing-paragraph",
      `Bilingual row ${row.rowId} has no matching paragraph`,
    );
  }
  if (row.disposition === "translate") {
    replaceText(row.rowId, target, translation);
    return;
  }
  if (row.disposition !== "inline") {
    return;
  }
  if (row.inTable) {
    const translated = target.cloneNode(true);
    if (!isElement(translated)) {
      return fail(
        "malformed-xml",
        `Could not clone bilingual row ${row.rowId}`,
      );
    }
    replaceText(row.rowId, translated, translation);
    appendInlineContent(doc, target, translated);
    return;
  }
  if (row.sourceParaId === null) {
    return fail(
      "missing-paragraph",
      `Bilingual inline row ${row.rowId} has no source paragraph`,
    );
  }
  const source = paragraphs.get(row.sourceParaId);
  if (!source) {
    return fail(
      "missing-paragraph",
      `Bilingual row ${row.rowId} has no matching source paragraph`,
    );
  }
  replaceText(row.rowId, target, translation);
  appendInlineContent(doc, source, target);
};

/**
 * Apply translated spans to Folio's cloned right-hand paragraphs. Inline rows
 * append that translated clone to the untouched source paragraph before the
 * table cells are structurally merged.
 */
export const applyFormattedBilingualTranslations = async (
  buffer: ArrayBuffer,
  rows: readonly StoredRow[],
  translations: ReadonlyMap<string, BilingualFormattedTranslation>,
): Promise<ArrayBuffer> => {
  const { archive, doc } = await loadDocumentPart(buffer);
  const paragraphs = paragraphById(doc);
  for (const row of rows) {
    const translation = translations.get(row.rowId);
    if (translation !== undefined) {
      applyRow(doc, paragraphs, row, translation);
    }
  }
  archive.zip.file(DOCUMENT_PART, slimdom.serializeToWellFormedString(doc));
  return await archive.zip.generateAsync({ type: "arraybuffer" });
};
