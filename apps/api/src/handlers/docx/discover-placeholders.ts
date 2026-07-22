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

import { placeholderPattern } from "@stll/template-conditions";

import { compareCodepoint } from "@/api/lib/collation";

import { paragraphText, templateContentPartPaths, W_NS } from "./ooxml";
import type { DiscoveredPlaceholder } from "./types";

// Canonical pattern from @stll/template-conditions (markers.ts) — the single
// source of truth shared with rich-patch, folio, and the web preview.
export const PLACEHOLDER_RE = placeholderPattern();

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
      const name = match.groups?.["name"];
      if (!name) {
        continue;
      }
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
};

/**
 * Discover all `{{placeholder}}` tags in a DOCX template.
 *
 * Scans `word/document.xml` plus all `word/header*.xml` and
 * `word/footer*.xml` entries. Value replacement mutates the
 * same parts, so discovery matches fill coverage.
 *
 * @returns {Promise<DiscoveredPlaceholder[]>} Deduplicated list
 *   with occurrence counts, sorted alphabetically by name.
 */
export const discoverPlaceholders = async (
  docxBuffer: Buffer,
): Promise<DiscoveredPlaceholder[]> => {
  const zip = await JSZip.loadAsync(docxBuffer);
  const counts = new Map<string, number>();

  for (const path of templateContentPartPaths(Object.keys(zip.files))) {
    const entry = zip.file(path);
    if (!entry) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- bounded memory while streaming content parts; accumulates into shared counts map
    const xml = await entry.async("string");
    scanParagraphs(slimdom.parseXmlDocument(xml), counts);
  }

  return (
    [...counts.entries()]
      // placeholder name is a template merge-field path, not display text
      .toSorted(([a], [b]) => compareCodepoint(a, b))
      .map(([name, count]) => ({ name, count }))
  );
};
