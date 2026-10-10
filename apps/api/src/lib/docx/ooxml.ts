/**
 * OOXML namespace URI and ID-generation helpers.
 *
 * IDs must be unique within the document; we scan for existing
 * ones and generate new IDs above the max.
 */

import type * as slimdom from "slimdom";

import { OOXML_NS } from "@stll/docx-utils";

export const W_NS = OOXML_NS.w;

/** Type guard that narrows `slimdom.Node` to `slimdom.Element`. */
export const isElement = (node: slimdom.Node): node is slimdom.Element =>
  node.nodeType === node.ELEMENT_NODE;

/**
 * Nearest ancestor (or self) that is a `w:<localName>` element, or `null`.
 * Used by loop expansion to decide whether an `{% for %}`/`{% endfor %}` marker
 * sits inside a table row (`w:tr`) or cell (`w:tc`).
 */
export const ancestorByLocalName = (
  node: slimdom.Node,
  localName: string,
): slimdom.Element | null => {
  let current: slimdom.Node | null = node;
  while (current) {
    if (
      isElement(current) &&
      current.localName === localName &&
      current.namespaceURI === W_NS
    ) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
};

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
const HEADER_FOOTER_RE = /^word\/(?:header|footer)\d+\.xml$/u;

export const MAIN_DOCUMENT_PART_PATH = "word/document.xml";

/** Every WordprocessingML part whose authored template content is visible. */
export const isTemplateContentPartPath = (path: string): boolean =>
  path === MAIN_DOCUMENT_PART_PATH || HEADER_FOOTER_RE.test(path);

/**
 * Deterministic shared traversal scope for discovery, directive processing,
 * value replacement, and AI adaptation. Keeping the scope in one function
 * prevents one pipeline phase from silently supporting fewer document parts.
 */
export const templateContentPartPaths = (paths: Iterable<string>): string[] =>
  [...paths].filter(isTemplateContentPartPath).toSorted();

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

/** Text owned by this paragraph; nested text-box paragraphs are separate units. */
export const paragraphOwnText = (paragraph: slimdom.Element): string => {
  let text = "";
  const walk = (node: slimdom.Node) => {
    if (!isElement(node)) {
      return;
    }
    if (
      node !== paragraph &&
      node.localName === "p" &&
      node.namespaceURI === W_NS
    ) {
      return;
    }
    if (node.localName === "t" && node.namespaceURI === W_NS) {
      text += node.textContent ?? "";
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };
  walk(paragraph);
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

/**
 * Remove one block-level unit (a paragraph, a row, or a whole table) and repair
 * the containers the removal would leave invalid: a `w:tc` must keep at least
 * one `w:p`, and a `w:tbl` at least one `w:tr` — Word reports a document
 * violating either as corrupt. Every directive removal path routes through
 * here (marker stripping, branch pruning, row removal, and the paragraph-index
 * fallback), so no path can invent a new way to empty a cell.
 */
export const removeBlockUnit = (unit: slimdom.Node): void => {
  const parent = unit.parentNode;
  if (!parent) {
    return;
  }
  if (isElement(unit) && unit.namespaceURI === W_NS && unit.localName === "p") {
    const properties = [...unit.childNodes].find(
      (child) =>
        isElement(child) &&
        child.namespaceURI === W_NS &&
        child.localName === "pPr",
    );
    if (
      properties &&
      isElement(properties) &&
      properties.getElementsByTagNameNS(W_NS, "sectPr").length > 0
    ) {
      // A section boundary owns page layout and header/footer references.
      // Retain that empty paragraph when its ordinary content is removed.
      for (const child of [...unit.childNodes]) {
        if (child !== properties) {
          unit.removeChild(child);
        }
      }
      return;
    }
  }
  // Resolve the containers to repair from the PARENT, not the direct
  // parent-child relation: a row-level content control wraps its `w:tr` in
  // `w:sdt`/`w:sdtContent`, so the enclosing table is an ancestor rather than
  // the row's parent, and a table-shell check on `parent` alone would miss it.
  const cell = ancestorByLocalName(parent, "tc");
  const table = ancestorByLocalName(parent, "tbl");
  parent.removeChild(unit);

  // The last row left the table: drop the shell, then repair whatever cell the
  // table itself lived in.
  if (table?.getElementsByTagNameNS(W_NS, "tr").length === 0) {
    removeBlockUnit(table);
    return;
  }

  const doc = cell?.ownerDocument;
  if (cell && doc && cell.getElementsByTagNameNS(W_NS, "p").length === 0) {
    cell.append(doc.createElementNS(W_NS, "w:p"));
  }
};
