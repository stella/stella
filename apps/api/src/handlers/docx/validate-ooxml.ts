/**
 * Lightweight post-generation OOXML validator.
 *
 * Checks structural invariants that matter for Word
 * compatibility. Each rule is a pure function that inspects
 * a parsed DOM and returns any violations found.
 */

import * as slimdom from "slimdom";

import { isElement, W_NS } from "./ooxml";

// ── Types ────────────────────────────────────────────────

type OoxmlViolation = {
  rule: string;
  message: string;
  element?: string | undefined;
};

type OoxmlValidationResult = {
  valid: boolean;
  violations: OoxmlViolation[];
};

// ── Helpers ──────────────────────────────────────────────

/** Collect all `w:id` values as an array (duplicates preserved). */
export const collectAllIds = (doc: slimdom.Document): number[] => {
  const ids: number[] = [];
  const walk = (node: slimdom.Node) => {
    if (isElement(node)) {
      const id = node.getAttributeNS(W_NS, "id") ?? node.getAttribute("w:id");
      if (id !== null) {
        const parsed = Number.parseInt(id, 10);
        if (!Number.isNaN(parsed)) {
          ids.push(parsed);
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

// ── Rules ────────────────────────────────────────────────

type Rule = (doc: slimdom.Document) => OoxmlViolation[];

/** All `w:id` values must be unique. */
const uniqueIds: Rule = (doc) => {
  const ids = collectAllIds(doc);
  if (ids.length === new Set(ids).size) {
    return [];
  }

  // Find the duplicates
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) {
      dupes.add(id);
    }
    seen.add(id);
  }

  return [
    {
      rule: "unique-ids",
      message: `Duplicate w:id values: ${[...dupes].join(", ")}`,
    },
  ];
};

/** Every `w:del` must contain at least one `w:delText`. */
const delHasDelText: Rule = (doc) => {
  const violations: OoxmlViolation[] = [];
  const dels = doc.getElementsByTagNameNS(W_NS, "del");

  for (const del of dels) {
    const delTexts = del.getElementsByTagNameNS(W_NS, "delText");
    if (delTexts.length === 0) {
      const id =
        del.getAttributeNS(W_NS, "id") ?? del.getAttribute("w:id") ?? "?";
      violations.push({
        rule: "del-has-delText",
        message: `w:del (id=${id}) has no w:delText descendant`,
        element: `w:del[w:id="${id}"]`,
      });
    }
  }

  return violations;
};

/** Every `w:ins` must contain at least one `w:r`. */
const insHasContent: Rule = (doc) => {
  const violations: OoxmlViolation[] = [];
  const inss = doc.getElementsByTagNameNS(W_NS, "ins");

  for (const ins of inss) {
    const runs = ins.getElementsByTagNameNS(W_NS, "r");
    if (runs.length === 0) {
      const id =
        ins.getAttributeNS(W_NS, "id") ?? ins.getAttribute("w:id") ?? "?";
      violations.push({
        rule: "ins-has-content",
        message: `w:ins (id=${id}) has no w:r descendant`,
        element: `w:ins[w:id="${id}"]`,
      });
    }
  }

  return violations;
};

/** Every `w:ins` and `w:del` must have `w:author` and `w:date`. */
const revisionAttrs: Rule = (doc) => {
  const violations: OoxmlViolation[] = [];

  const check = (elements: slimdom.Element[], tag: string) => {
    for (const el of elements) {
      const id =
        el.getAttributeNS(W_NS, "id") ?? el.getAttribute("w:id") ?? "?";
      const author =
        el.getAttributeNS(W_NS, "author") ?? el.getAttribute("w:author");
      const date = el.getAttributeNS(W_NS, "date") ?? el.getAttribute("w:date");

      if (!author) {
        violations.push({
          rule: "revision-attrs",
          message: `${tag} (id=${id}) missing w:author`,
          element: `${tag}[w:id="${id}"]`,
        });
      }
      if (!date) {
        violations.push({
          rule: "revision-attrs",
          message: `${tag} (id=${id}) missing w:date`,
          element: `${tag}[w:id="${id}"]`,
        });
      }
    }
  };

  check([...doc.getElementsByTagNameNS(W_NS, "ins")], "w:ins");
  check([...doc.getElementsByTagNameNS(W_NS, "del")], "w:del");

  return violations;
};

/** Comment range start/end/reference IDs must be balanced. */
const commentRefsBalanced: Rule = (doc) => {
  const violations: OoxmlViolation[] = [];

  const collectIds = (localName: string): Set<number> => {
    const els = doc.getElementsByTagNameNS(W_NS, localName);
    const ids = new Set<number>();
    for (const el of els) {
      const id = el.getAttributeNS(W_NS, "id") ?? el.getAttribute("w:id");
      if (id !== null) {
        const parsed = Number.parseInt(id, 10);
        if (!Number.isNaN(parsed)) {
          ids.add(parsed);
        }
      }
    }
    return ids;
  };

  const starts = collectIds("commentRangeStart");
  const ends = collectIds("commentRangeEnd");
  const refs = collectIds("commentReference");

  // Check for starts without ends
  for (const id of starts) {
    if (!ends.has(id)) {
      violations.push({
        rule: "comment-refs-balanced",
        message: `commentRangeStart (id=${id}) has no matching commentRangeEnd`,
      });
    }
  }

  // Check for ends without starts
  for (const id of ends) {
    if (!starts.has(id)) {
      violations.push({
        rule: "comment-refs-balanced",
        message: `commentRangeEnd (id=${id}) has no matching commentRangeStart`,
      });
    }
  }

  // Check for starts without references
  for (const id of starts) {
    if (!refs.has(id)) {
      violations.push({
        rule: "comment-refs-balanced",
        message: `commentRangeStart (id=${id}) has no matching commentReference`,
      });
    }
  }

  return violations;
};

// ── Public API ───────────────────────────────────────────

const RULES: Rule[] = [
  uniqueIds,
  delHasDelText,
  insHasContent,
  revisionAttrs,
  commentRefsBalanced,
];

export const validateOoxml = (documentXml: string): OoxmlValidationResult => {
  const doc = slimdom.parseXmlDocument(documentXml);
  const violations = RULES.flatMap((rule) => rule(doc));
  return { valid: violations.length === 0, violations };
};
