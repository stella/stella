/**
 * The converted document, written into the style set's own package.
 *
 * The style set is the container: its `styles.xml`, `numbering.xml`, theme,
 * fonts and page setup are what "house style" means, and copying a style
 * definition into the source document would reproduce a fraction of it. So
 * the body is replaced instead: every paragraph is rebuilt carrying only its
 * decided `w:pStyle`, its text, and the character emphasis a reader put
 * there. Direct paragraph formatting and the source's own `w:numPr` are
 * dropped, which is what lets the house style's numbering apply.
 *
 * A paragraph that typed its own number ("2.1", "(a)") under a house style
 * that numbers itself would print it twice, so the manual marker is removed
 * where the target style carries automatic numbering.
 */

import { panic } from "better-result";
import * as slimdom from "slimdom";

import { paragraphRuns, W_NS } from "@/api/lib/docx/ooxml";
import { attr, childElement, isElement } from "@/api/lib/house-style/catalogue";
import {
  bodyParagraphs,
  paragraphsWithin,
  stripManualMarker,
} from "@/api/lib/house-style/paragraphs";

const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** Character properties a conversion keeps; the rest is the style's business. */
const KEPT_RUN_PROPERTIES = ["b", "i", "u"] as const;

const textElements = (paragraph: slimdom.Element): slimdom.Element[] => {
  const found: slimdom.Element[] = [];
  const walk = (node: slimdom.Node): void => {
    for (const child of node.childNodes) {
      if (!isElement(child) || child.namespaceURI !== W_NS) {
        continue;
      }
      if (child.localName === "pPr") {
        continue;
      }
      if (child.localName === "t") {
        found.push(child);
        continue;
      }
      walk(child);
    }
  };
  walk(paragraph);
  return found;
};

type ConvertParagraphOptions = {
  source: slimdom.Element;
  target: slimdom.Document;
  styleId: string;
  /** How many leading characters of the paragraph's text to consume. */
  consume: number;
};

const convertParagraph = ({
  source,
  target,
  styleId,
  consume,
}: ConvertParagraphOptions): slimdom.Element => {
  const paragraph = target.createElementNS(W_NS, "w:p");
  const pPr = target.createElementNS(W_NS, "w:pPr");
  const pStyle = target.createElementNS(W_NS, "w:pStyle");
  pStyle.setAttributeNS(W_NS, "w:val", styleId);
  pPr.append(pStyle);
  paragraph.append(pPr);

  let remaining = consume;
  for (const run of paragraphRuns(source)) {
    const converted = target.createElementNS(W_NS, "w:r");
    const sourceProperties = childElement(run, "rPr");
    const kept =
      sourceProperties === null
        ? []
        : KEPT_RUN_PROPERTIES.filter(
            (name) => childElement(sourceProperties, name) !== null,
          );
    if (kept.length > 0) {
      const rPr = target.createElementNS(W_NS, "w:rPr");
      for (const name of kept) {
        rPr.append(target.createElementNS(W_NS, `w:${name}`));
      }
      converted.append(rPr);
    }
    for (const child of run.childNodes) {
      if (!isElement(child) || child.namespaceURI !== W_NS) {
        continue;
      }
      if (child.localName === "br" || child.localName === "tab") {
        converted.append(target.createElementNS(W_NS, `w:${child.localName}`));
        continue;
      }
      if (child.localName !== "t") {
        continue;
      }
      const original = child.textContent ?? "";
      const taken = Math.min(remaining, original.length);
      remaining -= taken;
      const text = original.slice(taken);
      const element = target.createElementNS(W_NS, "w:t");
      element.setAttributeNS(XML_NS, "xml:space", "preserve");
      element.append(target.createTextNode(text));
      converted.append(element);
    }
    if (converted.childNodes.length > 0) {
      paragraph.append(converted);
    }
  }
  return paragraph;
};

export type BuildConvertedBodyOptions = {
  houseDocumentXml: string;
  sourceDocumentXml: string;
  /** The decided house style per paragraph index, as `assign` produced it. */
  styleByIndex: ReadonlyMap<number, string>;
  /** What a table cell's unavoidable empty paragraph carries. */
  fallbackStyleId: string;
  /** Styles whose own numbering would double a manual marker in the text. */
  numberedStyleIds: ReadonlySet<string>;
  /** Styles the house `styles.xml` defines; a reference to anything else is dropped. */
  knownStyleIds: ReadonlySet<string>;
};

export type BuildConvertedBodyResult = {
  xml: string;
  droppedEmptyParagraphs: number;
  strippedManualMarkers: number;
};

const bodyOf = (doc: slimdom.Document): slimdom.Element | null =>
  doc.getElementsByTagNameNS(W_NS, "body").at(0) ?? null;

/** Table properties that name a style the house package does not define. */
const dropUnknownTableStyles = (
  table: slimdom.Element,
  knownStyleIds: ReadonlySet<string>,
): void => {
  for (const reference of table.getElementsByTagNameNS(W_NS, "tblStyle")) {
    const value = attr(reference, "val");
    if (value === null || !knownStyleIds.has(value)) {
      reference.remove();
    }
  }
};

export const buildConvertedBody = ({
  houseDocumentXml,
  sourceDocumentXml,
  styleByIndex,
  fallbackStyleId,
  numberedStyleIds,
  knownStyleIds,
}: BuildConvertedBodyOptions): BuildConvertedBodyResult => {
  const houseDoc = slimdom.parseXmlDocument(houseDocumentXml);
  const sourceDoc = slimdom.parseXmlDocument(sourceDocumentXml);
  const houseBody = bodyOf(houseDoc);
  const sourceBody = bodyOf(sourceDoc);
  if (houseBody === null || sourceBody === null) {
    return {
      xml: houseDocumentXml,
      droppedEmptyParagraphs: 0,
      strippedManualMarkers: 0,
    };
  }

  const ordered = bodyParagraphs(sourceBody);
  const decided = new Map<slimdom.Element, number>();
  let index = 0;
  for (const paragraph of ordered) {
    if (paragraph.text.length === 0) {
      continue;
    }
    decided.set(paragraph.element, index);
    index += 1;
  }
  const inTable = new Map(
    ordered.map(({ element, inTable: within }) => [element, within]),
  );

  let droppedEmptyParagraphs = 0;
  let strippedManualMarkers = 0;

  const convert = (source: slimdom.Element): slimdom.Element | null => {
    const paragraphIndex = decided.get(source);
    if (paragraphIndex === undefined) {
      if (inTable.get(source) !== true) {
        droppedEmptyParagraphs += 1;
        return null;
      }
      return convertParagraph({
        source,
        target: houseDoc,
        styleId: fallbackStyleId,
        consume: 0,
      });
    }
    const styleId = styleByIndex.get(paragraphIndex) ?? fallbackStyleId;
    const text = textElements(source)
      .map((element) => element.textContent ?? "")
      .join("");
    const { marker } = numberedStyleIds.has(styleId)
      ? stripManualMarker(text)
      : { marker: "" };
    if (marker.length > 0) {
      strippedManualMarkers += 1;
    }
    return convertParagraph({
      source,
      target: houseDoc,
      styleId,
      consume: marker.length,
    });
  };

  // A body child is a paragraph the rewrite rebuilds, a container whose
  // paragraphs it rebuilds in place, or something carrying no paragraph at
  // all, which it drops. A container it failed to recurse into would be a
  // paragraph decided and charged for and then missing from the document.
  const converted: slimdom.Node[] = [];
  for (const child of sourceBody.childNodes) {
    if (!isElement(child) || child.namespaceURI !== W_NS) {
      continue;
    }
    if (child.localName === "p") {
      const paragraph = convert(child);
      if (paragraph !== null) {
        converted.push(paragraph);
      }
      continue;
    }
    const sources = paragraphsWithin(child);
    if (sources.length === 0) {
      continue;
    }
    const imported = houseDoc.importNode(child, true);
    if (!isElement(imported)) {
      continue;
    }
    dropUnknownTableStyles(imported, knownStyleIds);
    const targets = paragraphsWithin(imported);
    for (const [position, origin] of sources.entries()) {
      const target = targets.at(position);
      if (target === undefined) {
        return panic("An imported container lost a paragraph the source held");
      }
      const replacement = convert(origin);
      if (replacement === null) {
        target.remove();
        continue;
      }
      target.parentNode?.replaceChild(replacement, target);
    }
    converted.push(imported);
  }

  // The style set's own section properties stay: page size, margins, and the
  // header and footer references are part of the house style.
  const sectPr = childElement(houseBody, "sectPr");
  houseBody.replaceChildren();
  for (const node of converted) {
    houseBody.append(node);
  }
  if (sectPr !== null) {
    houseBody.append(sectPr);
  }

  return {
    xml: slimdom.serializeToWellFormedString(houseDoc),
    droppedEmptyParagraphs,
    strippedManualMarkers,
  };
};

/** Every `w:pStyle` a part references, for the check that they all exist. */
export const collectReferencedStyleIds = (xml: string): Set<string> => {
  const doc = slimdom.parseXmlDocument(xml);
  const referenced = new Set<string>();
  for (const reference of doc.getElementsByTagNameNS(W_NS, "pStyle")) {
    const value = attr(reference, "val");
    if (value !== null) {
      referenced.add(value);
    }
  }
  return referenced;
};

export const collectDefinedStyleIds = (stylesXml: string): Set<string> => {
  const doc = slimdom.parseXmlDocument(stylesXml);
  const defined = new Set<string>();
  for (const style of doc.getElementsByTagNameNS(W_NS, "style")) {
    const id = attr(style, "styleId");
    if (id !== null) {
      defined.add(id);
    }
  }
  return defined;
};

/** Text of a part, removed but its structure kept: a footer keeps its fields. */
export const stripPartText = (xml: string): string => {
  const doc = slimdom.parseXmlDocument(xml);
  for (const element of doc.getElementsByTagNameNS(W_NS, "t")) {
    element.replaceChildren();
  }
  return slimdom.serializeToWellFormedString(doc);
};

/**
 * Notes belonging to the style-set document, dropped. The separator and
 * continuation notes stay: Word requires them, and they carry no text.
 */
export const stripNotes = (xml: string, localName: string): string => {
  const doc = slimdom.parseXmlDocument(xml);
  for (const note of [...doc.getElementsByTagNameNS(W_NS, localName)]) {
    if (attr(note, "type") === null) {
      note.remove();
    }
  }
  return slimdom.serializeToWellFormedString(doc);
};

/** A part kept but emptied: a comment store belonging to the style-set document. */
export const emptyRootChildren = (xml: string): string => {
  const doc = slimdom.parseXmlDocument(xml);
  const root = doc.documentElement;
  if (root === null) {
    return xml;
  }
  root.replaceChildren();
  return slimdom.serializeToWellFormedString(doc);
};

/** Elements emptied in place, for the document properties a copy must not carry. */
export const emptyXmlElements = (
  xml: string,
  names: readonly string[],
): string => {
  let emptied = xml;
  for (const name of names) {
    emptied = emptyXmlElement(emptied, name);
  }
  return emptied;
};

/** One element emptied in place, keeping its attributes. */
const emptyXmlElement = (xml: string, name: string): string =>
  xml.replaceAll(
    new RegExp(`<${name}(\\s[^>]*)?>[\\s\\S]*?</${name}>`, "gu"),
    (_match: string, attributes: string | undefined) =>
      `<${name}${attributes ?? ""}></${name}>`,
  );
