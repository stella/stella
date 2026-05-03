/**
 * Server-side DOCX → folio block extractor for the AI extraction
 * workflow.
 *
 * The chat path produces `FolioAIBlock`s from a live folio editor by
 * walking the ProseMirror tree; that's the canonical implementation
 * but it can't run server-side without dragging the editor's DOM
 * dependencies through TypeScript. This file mirrors the same block
 * shape (id format, kind detection, displayLabel rules) directly
 * against the DOCX XML so the AI prompt and frontend renderer agree
 * on the data they're exchanging.
 *
 * Phase 1 feature parity with the chat snapshot:
 *  - sequential `b-NNNN` IDs in document order
 *  - one block per paragraph; empty paragraphs are dropped
 *  - kind = "heading" | "listItem" | "paragraph"
 *  - listItem displayLabel = list marker text when present
 *  - heading displayLabel = "headingN" when the style id matches
 */

import type { FolioAIBlock } from "@stll/folio/server";
import JSZip from "jszip";
import * as slimdom from "slimdom";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const elementsByLocalName = (
  parent: slimdom.Element | slimdom.Document,
  localName: string,
): slimdom.Element[] =>
  parent
    .getElementsByTagNameNS(W_NS, localName)
    .filter((node): node is slimdom.Element => node.nodeType === 1);

const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";

// Subtrees we never descend into when collecting paragraph text.
//
//   - `w:moveFrom`, `w:del`: tracked-change DELETIONS; the "final"
//     view of the document excludes them, so include only the
//     resulting text (`w:moveTo`, `w:ins` are visited normally as
//     children of the paragraph).
//   - `mc:Fallback`: the legacy branch of `mc:AlternateContent`.
//     The preferred branch lives in a sibling `mc:Choice`; visiting
//     both would emit the same text twice for compatibility-wrapped
//     content (e.g. drawings with a fallback shape).
const isSkippableSubtree = (element: slimdom.Element): boolean => {
  if (element.namespaceURI === W_NS) {
    return element.localName === "moveFrom" || element.localName === "del";
  }
  if (element.namespaceURI === MC_NS) {
    return element.localName === "Fallback";
  }
  return false;
};

const collectText = (paragraph: slimdom.Element): string => {
  const parts: string[] = [];

  const walk = (node: slimdom.Node) => {
    if (!(node instanceof slimdom.Element)) {
      return;
    }
    if (isSkippableSubtree(node)) {
      return;
    }

    if (node.namespaceURI === W_NS) {
      if (node.localName === "t") {
        parts.push(node.textContent ?? "");
        return;
      }
      if (node.localName === "tab") {
        parts.push("\t");
        return;
      }
      if (node.localName === "br") {
        parts.push("\n");
        return;
      }
    }

    for (const child of node.childNodes) {
      walk(child);
    }
  };

  walk(paragraph);
  return parts.join("");
};

const getStyleId = (paragraph: slimdom.Element): string | undefined => {
  const pPr = paragraph.getElementsByTagNameNS(W_NS, "pPr").at(0);
  if (!pPr) {
    return undefined;
  }
  const pStyle = pPr.getElementsByTagNameNS(W_NS, "pStyle").at(0);
  return pStyle?.getAttributeNS(W_NS, "val") ?? undefined;
};

const getNumberingMarker = (paragraph: slimdom.Element): string | undefined => {
  const pPr = paragraph.getElementsByTagNameNS(W_NS, "pPr").at(0);
  if (!pPr) {
    return undefined;
  }
  const numPr = pPr.getElementsByTagNameNS(W_NS, "numPr").at(0);
  if (!numPr) {
    return undefined;
  }
  const ilvl = numPr
    .getElementsByTagNameNS(W_NS, "ilvl")
    .at(0)
    ?.getAttributeNS(W_NS, "val");
  // Without resolving the numbering definitions we only know that
  // this paragraph IS a list item, not which marker it would render
  // as. Use the level as a stand-in label so the AI can group items;
  // the editor-side snapshot has the resolved marker, but Phase 1
  // doesn't need pixel parity here.
  return ilvl ? `list-l${ilvl}` : "list";
};

const getOutlineLevel = (paragraph: slimdom.Element): number | undefined => {
  const pPr = paragraph.getElementsByTagNameNS(W_NS, "pPr").at(0);
  if (!pPr) {
    return undefined;
  }
  const outlineLvl = pPr
    .getElementsByTagNameNS(W_NS, "outlineLvl")
    .at(0)
    ?.getAttributeNS(W_NS, "val");
  if (!outlineLvl) {
    return undefined;
  }
  const parsed = Number(outlineLvl);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const detectKind = (
  paragraph: slimdom.Element,
): { kind: FolioAIBlock["kind"]; displayLabel?: string } => {
  const numberingMarker = getNumberingMarker(paragraph);
  if (numberingMarker) {
    return { kind: "listItem", displayLabel: numberingMarker };
  }

  const styleId = getStyleId(paragraph);
  if (styleId && /^heading/i.test(styleId)) {
    return { kind: "heading", displayLabel: styleId };
  }

  const outlineLevel = getOutlineLevel(paragraph);
  if (outlineLevel !== undefined && outlineLevel >= 0) {
    return { kind: "heading" };
  }

  return { kind: "paragraph" };
};

export const extractFolioBlocksFromDocxBuffer = async (
  buffer: ArrayBuffer,
): Promise<FolioAIBlock[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) {
    return [];
  }

  const xml = await documentEntry.async("text");
  const document = slimdom.parseXmlDocument(xml);
  const paragraphs = elementsByLocalName(document, "p");

  const blocks: FolioAIBlock[] = [];
  let blockIndex = 0;

  for (const paragraph of paragraphs) {
    const text = collectText(paragraph).replace(/\s+/g, " ").trim();
    if (text.length === 0) {
      continue;
    }

    const { kind, displayLabel } = detectKind(paragraph);
    const id = `b-${String(++blockIndex).padStart(4, "0")}`;
    blocks.push({
      id,
      kind,
      text,
      ...(displayLabel ? { displayLabel } : {}),
    });
  }

  return blocks;
};
