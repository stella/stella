import JSZip from "jszip";
import * as slimdom from "slimdom";

import {
  extractDocxText,
  type ExtractedDocxText,
} from "@stll/folio-core/server";

import { loadDocxArchive } from "@/api/lib/docx-archive";

import { isElement, templateContentPartPaths, W_NS } from "./ooxml";

const DOCUMENT_RELATIONSHIPS_PATH = "word/_rels/document.xml.rels";

const hasTableAncestor = (table: slimdom.Element): boolean => {
  let ancestor = table.parentNode;
  while (ancestor !== null) {
    if (
      isElement(ancestor) &&
      ancestor.namespaceURI === W_NS &&
      ancestor.localName === "tbl"
    ) {
      return true;
    }
    ancestor = ancestor.parentNode;
  }
  return false;
};

/**
 * Replace each outer table with clones of its authored paragraphs. Folio then
 * applies its normal accepted-revision and formatting extraction to those
 * paragraphs instead of serializing the table as lossy GFM rows.
 */
const unwrapTableParagraphs = (xml: string): string => {
  const document = slimdom.parseXmlDocument(xml);
  const tables = document
    .getElementsByTagNameNS(W_NS, "tbl")
    .filter((table) => !hasTableAncestor(table));
  for (const table of tables) {
    const parent = table.parentNode;
    if (parent === null) {
      continue;
    }
    for (const paragraph of table.getElementsByTagNameNS(W_NS, "p")) {
      parent.insertBefore(paragraph.cloneNode(true), table);
    }
    parent.removeChild(table);
  }
  return slimdom.serializeToWellFormedString(document);
};

/**
 * Template preview needs authored paragraphs, including the formatting of each
 * table-cell paragraph. Folio's general extractor intentionally serializes
 * tables as GFM rows, which cannot carry this per-paragraph metadata.
 */
export const extractPreviewText = async (
  docxBytes: Uint8Array,
): Promise<ExtractedDocxText> => {
  const archive = await loadDocxArchive(docxBytes);
  const previewArchive = new JSZip();
  const contentPartPaths = templateContentPartPaths(
    Object.keys(archive.zip.files),
  );
  const addContentPart = async (index: number): Promise<void> => {
    const path = contentPartPaths.at(index);
    if (path === undefined) {
      return;
    }

    const xml = await archive.readEntryString(path);
    if (xml !== null) {
      previewArchive.file(path, unwrapTableParagraphs(xml));
    }
    await addContentPart(index + 1);
  };
  await addContentPart(0);

  const relationships = await archive.readEntryString(
    DOCUMENT_RELATIONSHIPS_PATH,
  );
  if (relationships !== null) {
    previewArchive.file(DOCUMENT_RELATIONSHIPS_PATH, relationships);
  }

  const previewBytes = await previewArchive.generateAsync({
    type: "uint8array",
  });
  return await extractDocxText(previewBytes);
};
