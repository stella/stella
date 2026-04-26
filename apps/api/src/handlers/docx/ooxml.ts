/**
 * OOXML namespace URI and ID-generation helpers.
 *
 * IDs must be unique within the document; we scan for existing
 * ones and generate new IDs above the max.
 */

import type * as slimdom from "slimdom";

import { OOXML_NS } from "@stella/docx-utils";

export const W_NS = OOXML_NS.w;

/** Type guard that narrows `slimdom.Node` to `slimdom.Element`. */
export const isElement = (node: slimdom.Node): node is slimdom.Element =>
  node.nodeType === node.ELEMENT_NODE;

// ── ID helpers ────────────────────────────────────────────

/** Walk the DOM tree and collect all integer `w:id` attribute values. */
export const collectExistingIds = (doc: slimdom.Document): Set<number> => {
  const ids = new Set<number>();

  const walk = (node: slimdom.Node) => {
    if (isElement(node)) {
      const id = node.getAttributeNS(W_NS, "id") ?? node.getAttribute("w:id");
      if (id !== null) {
        const parsed = Number.parseInt(id, 10);
        if (!Number.isNaN(parsed)) {
          ids.add(parsed);
        }
      }
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };

  walk(doc);
  return ids;
};

/** Word uses 32-bit signed integers for w:id. */
const INT32_MAX = 2_147_483_647;

/**
 * Create a monotonically increasing ID generator that starts
 * above the highest existing ID in the document.
 *
 * When IDs approach INT32_MAX, wraps around to find unused
 * values starting from 1, avoiding collisions with existing IDs.
 */
/** Regex matching header and footer XML entry paths. */
export const HEADER_FOOTER_RE = /^word\/(header|footer)\d+\.xml$/;

// ── Text helpers ─────────────────────────────────────────

/**
 * Concatenate all `w:t` text in a paragraph (handles split
 * runs). Shared by placeholder discovery and block-directive
 * processing.
 */
export const paragraphText = (p: slimdom.Element): string => {
  let text = "";
  const walk = (node: slimdom.Node) => {
    if (isElement(node)) {
      if (node.localName === "t" && node.namespaceURI === W_NS) {
        text += node.textContent ?? "";
      } else {
        for (const child of node.childNodes) {
          walk(child);
        }
      }
    }
  };
  walk(p);
  return text;
};

// ── ID helpers ────────────────────────────────────────────

export const createIdGenerator = (existingIds: Set<number>): (() => number) => {
  let maxId = 0;
  for (const id of existingIds) {
    if (id > maxId) {
      maxId = id;
    }
  }
  let next = existingIds.size > 0 ? maxId + 1 : 1;

  // If existing IDs are already at the limit, find a gap from 1
  if (next > INT32_MAX) {
    next = 1;
    while (existingIds.has(next) && next <= INT32_MAX) {
      next++;
    }
  }

  return () => {
    const id = next;
    existingIds.add(id);
    next++;
    // Wrap around if we hit the ceiling
    if (next > INT32_MAX) {
      next = 1;
      while (existingIds.has(next) && next <= INT32_MAX) {
        next++;
      }
    }
    return id;
  };
};
