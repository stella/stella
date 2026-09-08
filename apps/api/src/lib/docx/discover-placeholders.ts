/**
 * Scan a DOCX template for `{{ value }}` markers.
 *
 * Word may split a single placeholder across multiple `w:r` runs
 * (e.g. due to spell-check or formatting changes). We concatenate
 * all `w:t` text within each `w:p` paragraph before scanning, so
 * split tags are detected correctly.
 */

import JSZip from "jszip";
import * as slimdom from "slimdom";

import { compareCodeUnit } from "@stll/collation";
import { scanMarkers } from "@stll/template-conditions";
import type { FilterCall } from "@stll/template-conditions";

import { paragraphText, templateContentPartPaths, W_NS } from "./ooxml";
import type { DiscoveredPlaceholder } from "./types";

/** One value marker as discovery reads it: the path it fills from, the
 *  filters that configure it, and where it sits in the paragraph text. */
export type ScannedPlaceholder = {
  name: string;
  filters: readonly FilterCall[];
  /** Offset of the marker's `{{` in the scanned text. */
  start: number;
  /** Offset just past the marker's `}}`. */
  end: number;
};

/**
 * The value markers in one paragraph's text, in document order. Reading them
 * through the grammar's scanner rather than a bare pattern is what keeps
 * `{{ loop.index }}` and `{{ clause("X") }}` out of the discovered field list:
 * they are markers, but not fillable values.
 */
export const scanPlaceholders = (text: string): ScannedPlaceholder[] =>
  scanMarkers(text).flatMap(({ end, meta, start }) =>
    meta.kind === "placeholder"
      ? [{ name: meta.expr, filters: meta.filters, start, end }]
      : [],
  );

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
    for (const { name } of scanPlaceholders(paragraphText(p))) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
};

/**
 * Discover all `{{ value }}` markers in a DOCX template.
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

    const xml = await entry.async("string");
    scanParagraphs(slimdom.parseXmlDocument(xml), counts);
  }

  return (
    [...counts.entries()]
      // placeholder name is a template merge-field path, not display text
      .toSorted(([a], [b]) => compareCodeUnit(a, b))
      .map(([name, count]) => ({ name, count }))
  );
};
