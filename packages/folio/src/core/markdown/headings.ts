/**
 * Heading-style detection from a paragraph style id. Ported from eigenpal
 * `agent/text-utils` (PR #595) so the markdown exporter stays self-contained
 * (folio has no `agent/text-utils` module). Word's built-in heading styles are
 * `Heading1`…`Heading9` (and localised aliases that still contain "heading").
 */

/** True when the style id denotes a Word heading style. */
export function isHeadingStyle(styleId?: string): boolean {
  if (!styleId) {
    return false;
  }
  return styleId.toLowerCase().includes("heading");
}

/** Extract the 1-based heading level from a style id, or undefined. */
export function parseHeadingLevel(styleId?: string): number | undefined {
  if (!styleId) {
    return undefined;
  }
  const digit = /heading\s*(\d)/iu.exec(styleId)?.[1];
  if (digit) {
    return Number.parseInt(digit, 10);
  }
  return undefined;
}
