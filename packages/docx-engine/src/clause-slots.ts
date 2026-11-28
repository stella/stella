/**
 * Scan a DOCX template for `{{ clause("SlotName") }}` markers.
 *
 * Clause slot markers follow the pattern:
 *   `{{ clause("Name") }}`            — use pinned version
 *   `{{ clause("Name", "latest") }}`  — always use latest
 *   `{{ clause("Name", "v3") }}`      — use version 3
 */

import * as slimdom from "slimdom";

import { loadDocx } from "@stll/docx-utils";
import { clauseSlotKey, clauseSlotPattern } from "@stll/template-conditions";

import { paragraphText, templateContentPartPaths, W_NS } from "./ooxml";

// ── Types ────────────────────────────────────────────

export type ClauseSlot = {
  name: string;
  versionModifier?: string | undefined;
  /** The values-map key the marker substitutes from (e.g.
   *  "@clause:NonCompete"), shared with the patcher via `clauseSlotKey`. */
  patchKey: string;
};

// ── Regex ────────────────────────────────────────────

// Canonical pattern from @stll/template-conditions (markers.ts); the patch key
// is built with `clauseSlotKey`, the same helper the patcher derives a clause
// marker's substitution key from, so the two cannot disagree.
const CLAUSE_SLOT_RE = clauseSlotPattern();

// ── Scanning ─────────────────────────────────────────

export const collectClauseSlots = (
  doc: slimdom.Document | slimdom.Element,
  slots: Map<string, ClauseSlot>,
): void => {
  const paragraphs = doc.getElementsByTagNameNS(W_NS, "p");

  for (const p of paragraphs) {
    const text = paragraphText(p);
    for (const match of text.matchAll(CLAUSE_SLOT_RE)) {
      const name = match.groups?.["name"];
      if (!name) {
        continue;
      }
      const modifier = match.groups?.["modifier"] || undefined;
      const patchKey = clauseSlotKey(name, modifier);

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

/**
 * Discover all `{{ clause(...) }}` markers from DOCX bytes.
 * Scans body, headers, and footers.
 */
export const discoverClauseSlotsFromBytes = async (
  bytes: ArrayBuffer | Uint8Array,
): Promise<ClauseSlot[]> => {
  const zip = await loadDocx(bytes);
  const slots = new Map<string, ClauseSlot>();

  for (const path of templateContentPartPaths(zip.paths())) {
    const entry = zip.entry(path);
    if (!entry) {
      continue;
    }
    const xml = await entry.text();
    collectClauseSlots(slimdom.parseXmlDocument(xml), slots);
  }

  return Array.from(slots.values());
};
