/**
 * Scan a DOCX template for `{{@clause:SlotName}}` markers.
 *
 * Clause slot markers follow the pattern:
 *   `{{@clause:Name}}`         — use pinned version
 *   `{{@clause:Name:latest}}`  — always use latest
 *   `{{@clause:Name:v3}}`      — use version 3
 */

import JSZip from "jszip";
import * as slimdom from "slimdom";

import { clauseSlotPattern } from "@stll/template-conditions";

import { HEADER_FOOTER_RE, paragraphText, W_NS } from "./ooxml";

// ── Types ────────────────────────────────────────────

export type ClauseSlot = {
  name: string;
  versionModifier?: string | undefined;
  /** The full marker text (e.g., "@clause:NonCompete") used
   *  as the patch key for `fillTemplate`. */
  patchKey: string;
};

// ── Regex ────────────────────────────────────────────

// Canonical pattern from @stll/template-conditions (markers.ts). The name and
// modifier captures exclude whitespace so the rebuilt patch key matches what
// rich-patch's PLACEHOLDER_RE captures during replacement (they must agree).
const CLAUSE_SLOT_RE = clauseSlotPattern();

// ── Scanning ─────────────────────────────────────────

const scanParagraphs = (
  doc: slimdom.Document,
  slots: Map<string, ClauseSlot>,
): void => {
  const paragraphs = doc.getElementsByTagNameNS(W_NS, "p");

  for (const p of paragraphs) {
    const text = paragraphText(p);
    for (const match of text.matchAll(CLAUSE_SLOT_RE)) {
      const name = match[1];
      if (!name) {
        continue;
      }
      const modifier = match[2] || undefined;
      const patchKey = modifier
        ? `@clause:${name}:${modifier}`
        : `@clause:${name}`;

      if (!slots.has(patchKey)) {
        slots.set(patchKey, {
          name,
          versionModifier: modifier,
          patchKey,
        });
      }
    }
  }
};

// ── Public API ───────────────────────────────────────

/**
 * Discover all `{{@clause:...}}` markers in a DOCX
 * template. Scans body, headers, and footers.
 */
export const discoverClauseSlots = async (
  docxBuffer: Buffer,
): Promise<ClauseSlot[]> => {
  const zip = await JSZip.loadAsync(docxBuffer);
  const slots = new Map<string, ClauseSlot>();

  const docEntry = zip.file("word/document.xml");
  if (!docEntry) {
    return [];
  }

  const docXml = await docEntry.async("string");
  scanParagraphs(slimdom.parseXmlDocument(docXml), slots);

  const hfEntries = Object.keys(zip.files).filter((path) =>
    HEADER_FOOTER_RE.test(path),
  );

  for (const path of hfEntries) {
    const entry = zip.file(path);
    if (!entry) {
      continue;
    }

    const xml = await entry.async("string");
    scanParagraphs(slimdom.parseXmlDocument(xml), slots);
  }

  return [...slots.values()];
};
