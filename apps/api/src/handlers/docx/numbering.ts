/**
 * Cross-reference numbering for templates.
 *
 * `{{@num:Key}}` marks a numbered item (a clause or term). At fill time —
 * *after* conditional removal — each surviving `@num` marker is assigned a
 * sequential number in document order and replaced with that number.
 * `{{@ref:Key}}` then resolves to the number assigned to `Key`.
 *
 * This lets prose like "as set out in Clause {{@ref:rent}}" track a clause
 * that may be conditionally included or excluded: if the `{{@num:rent}}`
 * clause is dropped by a `{{#if}}`, the reference is left unresolved rather
 * than pointing at a stale number.
 *
 * Keys inside an `{{#each}}` body are rewritten by loop expansion (see
 * block-directives.ts) to per-iteration synthetic keys, so each expanded copy
 * is numbered as its own item and `@ref`s within the same iteration resolve
 * to that copy's number. A `@ref` that crosses a loop boundary inward (a bare
 * key whose only `@num` lives inside a loop) stays unresolved by design:
 * there is no single number to point at.
 *
 * Operates on raw WordprocessingML text. Markers are kept out of the
 * user-facing field schema by discovery (it skips `@`-prefixed names).
 */

import {
  hasNumberingPattern,
  numPattern,
  refPattern,
} from "@stll/template-conditions";

// Canonical patterns from @stll/template-conditions (markers.ts).
const NUM_RE = numPattern();
const REF_RE = refPattern();
const ANY_MARKER_RE = hasNumberingPattern();

/** Fast-path: does this part contain any numbering markers at all? */
export const hasNumberingMarkers = (xml: string): boolean =>
  ANY_MARKER_RE.test(xml);

/**
 * Replace each `{{@num:Key}}` with a sequential number (1-based, in document
 * order) and return the key→number map. Markers appearing earlier in the XML
 * get lower numbers; conditionally-removed markers are already gone, so the
 * numbering reflects the assembled document.
 */
export const assignNumbers = (
  xml: string,
): { xml: string; numbers: Map<string, number> } => {
  const numbers = new Map<string, number>();
  let counter = 0;
  const rewritten = xml.replace(NUM_RE, (_match, key: string) => {
    // A key may be marked once; a repeated @num reuses its first number.
    const existing = numbers.get(key);
    if (existing !== undefined) {
      return String(existing);
    }
    counter += 1;
    numbers.set(key, counter);
    return String(counter);
  });
  return { xml: rewritten, numbers };
};

/**
 * Replace `{{@ref:Key}}` with the number assigned to `Key`. Unresolved
 * references (the target `@num` was conditionally excluded, or never existed)
 * are left intact so they surface as unmatched-placeholder diagnostics rather
 * than silently vanishing or emitting a wrong number.
 */
export const resolveRefs = (
  xml: string,
  numbers: ReadonlyMap<string, number>,
): string =>
  xml.replace(REF_RE, (match, key: string) => {
    const assigned = numbers.get(key);
    return assigned === undefined ? match : String(assigned);
  });

/** Number `@num` markers then resolve `@ref` markers in one pass over one part. */
export const applyNumbering = (xml: string): string => {
  const { xml: numbered, numbers } = assignNumbers(xml);
  return resolveRefs(numbered, numbers);
};
