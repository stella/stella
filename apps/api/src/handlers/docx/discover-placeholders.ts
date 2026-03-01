/**
 * Scan a DOCX template for {{placeholder}} tags.
 *
 * Word may split a single placeholder across multiple `w:r` runs
 * (e.g. due to spell-check or formatting changes). We concatenate
 * all `w:t` text within each `w:p` paragraph before scanning, so
 * split tags are detected correctly.
 */

import JSZip from "jszip";
import * as slimdom from "slimdom";

import { HEADER_FOOTER_RE, paragraphText, W_NS } from "./ooxml";
import type { DiscoveredPlaceholder } from "./types";

export const PLACEHOLDER_RE = /\{\{([\p{L}\p{N}_.]+)\}\}/gu;

/**
 * Scan all `w:p` paragraphs in a parsed XML document and
 * accumulate placeholder counts.
 */
const scanParagraphs = (
  doc: slimdom.Document,
  counts: Map<string, number>,
): void => {
  const paragraphs = doc.getElementsByTagNameNS(W_NS, "p");

  for (const p of paragraphs) {
    const text = paragraphText(p);
    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      const name = match[1];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
};

/**
 * Discover all `{{placeholder}}` tags in a DOCX template.
 *
 * Scans `word/document.xml` plus all `word/header*.xml` and
 * `word/footer*.xml` entries. `patchDocument` patches across
 * all parts, so this ensures discovery matches fill coverage.
 *
 * @returns Deduplicated list with occurrence counts, sorted
 *          alphabetically by name.
 */
export const discoverPlaceholders = async (
  docxBuffer: Buffer,
): Promise<DiscoveredPlaceholder[]> => {
  const zip = await JSZip.loadAsync(docxBuffer);
  const counts = new Map<string, number>();

  // Scan document body
  const docEntry = zip.file("word/document.xml");
  if (!docEntry) {
    return [];
  }

  const docXml = await docEntry.async("string");
  scanParagraphs(slimdom.parseXmlDocument(docXml), counts);

  // Scan headers and footers
  const hfEntries = Object.keys(zip.files).filter((path) =>
    HEADER_FOOTER_RE.test(path),
  );

  for (const path of hfEntries) {
    const entry = zip.file(path);
    if (!entry) {
      continue;
    }

    const xml = await entry.async("string");
    scanParagraphs(slimdom.parseXmlDocument(xml), counts);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }));
};
