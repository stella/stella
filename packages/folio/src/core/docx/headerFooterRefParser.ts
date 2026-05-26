/**
 * Header/Footer Reference Parser
 *
 * Parses header/footer references (w:headerReference, w:footerReference) that
 * appear in section properties. Extracted from headerFooterParser to break the
 * circular dependency: headerFooterParser -> paragraphParser -> sectionParser -> headerFooterParser.
 */

import type {
  HeaderFooterType,
  HeaderReference,
  FooterReference,
} from "../types/document";
import { findChildren, getAttribute } from "./xmlParser";
import type { XmlElement } from "./xmlParser";

/**
 * Parse header type attribute
 */
function parseHeaderFooterType(typeAttr: string | null): HeaderFooterType {
  switch (typeAttr) {
    case "first":
      return "first";
    case "even":
      return "even";
    default:
      return "default";
  }
}

function parseHeaderFooterReference(element: XmlElement) {
  const typeAttr = getAttribute(element, "w", "type");
  const rId = getAttribute(element, "r", "id") ?? "";

  return {
    type: parseHeaderFooterType(typeAttr),
    rId,
  };
}

/**
 * Parse a header reference from sectPr (w:headerReference)
 */
export function parseHeaderReference(element: XmlElement): HeaderReference {
  return parseHeaderFooterReference(element);
}

/**
 * Parse a footer reference from sectPr (w:footerReference)
 */
export function parseFooterReference(element: XmlElement): FooterReference {
  return parseHeaderFooterReference(element);
}

/**
 * Parse all header references from a sectPr element
 */
export function parseHeaderReferences(sectPr: XmlElement): HeaderReference[] {
  const refs: HeaderReference[] = [];
  const headerRefElements = findChildren(sectPr, "w", "headerReference");

  for (const el of headerRefElements) {
    refs.push(parseHeaderReference(el));
  }

  return refs;
}

/**
 * Parse all footer references from a sectPr element
 */
export function parseFooterReferences(sectPr: XmlElement): FooterReference[] {
  const refs: FooterReference[] = [];
  const footerRefElements = findChildren(sectPr, "w", "footerReference");

  for (const el of footerRefElements) {
    refs.push(parseFooterReference(el));
  }

  return refs;
}
