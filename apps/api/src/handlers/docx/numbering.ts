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
 * Two surfaces exist for the same grammar:
 *  - the raw-text helpers (`assignNumbers`/`resolveRefs`/`applyNumbering`)
 *    operate on a serialized XML string and only see a marker that survives
 *    contiguously in one `w:t`;
 *  - the paragraph/DOM helpers (`assignNumbersInDoc`/`resolveRefsInDoc`) scan
 *    each paragraph's concatenated span text (`paragraphSpanText`) and rewrite
 *    via `replaceParagraphTextRanges`, so a `{{@num}}`/`{{@ref}}` Word split
 *    across runs is seen and resolved — mirroring how discover-placeholders /
 *    rich-patch handle split placeholder runs. The fill pipeline drives the DOM
 *    helpers; the raw-text helpers remain for callers/tests that work on a
 *    contiguous string.
 *
 * Markers are kept out of the user-facing field schema by discovery (it skips
 * `@`-prefixed names).
 */

import type * as slimdom from "slimdom";

import {
  hasNumberingPattern,
  numPattern,
  refPattern,
} from "@stll/template-conditions";

import { isElement, W_NS } from "./ooxml";
import { paragraphSpanText, replaceParagraphTextRanges } from "./rich-patch";

// Canonical patterns from @stll/template-conditions (markers.ts).
const NUM_RE = numPattern();
const REF_RE = refPattern();
const ANY_MARKER_RE = hasNumberingPattern();

/** Fast-path for the raw-string helpers: a *contiguous* numbering marker. */
export const hasNumberingMarkers = (xml: string): boolean =>
  ANY_MARKER_RE.test(xml);

/**
 * Split-safe pre-filter for the DOM pass: whether a part *might* hold a
 * numbering marker once runs are joined. A marker can be split at any character
 * boundary, so no multi-character substring (`@num:`, even `{{`) is guaranteed
 * contiguous in the raw XML — but every `{{@num:}}`/`{{@ref:}}` contains the
 * single `@` character, which cannot itself be split. A part with no `@` has no
 * marker; a stray `@` only costs one needless parse that mutates nothing.
 */
export const mightContainNumberingMarkers = (xml: string): boolean =>
  xml.includes("@");

/**
 * Replace each `{{@num:Key}}` with a sequential number (1-based, in document
 * order) and return the key→number map. Markers appearing earlier in the XML
 * get lower numbers; conditionally-removed markers are already gone, so the
 * numbering reflects the assembled document.
 *
 * Pass an existing `numbers` map to share one counter space across multiple
 * parts (body + headers/footers): each part continues the running count and a
 * key already numbered by an earlier part reuses its number. The map is
 * mutated in place and returned. Call parts in document order (body first) so
 * the count reflects reading order, then `resolveRefs` every part with the
 * fully-populated map so an `@ref` resolves to a `@num` in any other part.
 */
export const assignNumbers = (
  xml: string,
  numbers: Map<string, number> = new Map<string, number>(),
): { xml: string; numbers: Map<string, number> } => {
  const rewritten = xml.replace(NUM_RE, (_match, key: string) => {
    // A key may be marked once; a repeated @num reuses its first number.
    const existing = numbers.get(key);
    if (existing !== undefined) {
      return String(existing);
    }
    const next = numbers.size + 1;
    numbers.set(key, next);
    return String(next);
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

// ── DOM (split-run-aware) numbering ──────────────────────────
// These scan each paragraph's concatenated span text so a `{{@num}}`/`{{@ref}}`
// split across runs is seen, then rewrite the marker in place. Offsets are
// computed from `paragraphSpanText` (the patcher's coordinate space), never
// from `paragraphText`, so they cannot drift from the `w:t` walk below or from
// `replaceParagraphTextRanges`.

const paragraphsOf = (doc: slimdom.Document): slimdom.Element[] => [
  ...doc.getElementsByTagNameNS(W_NS, "p"),
];

type NumberingRange = { start: number; end: number; value: string };

type TextNodeSpan = { node: slimdom.Element; start: number; end: number };

/** The `w:t` nodes of a paragraph with their offsets into `paragraphSpanText`. */
const textNodeSpans = (paragraph: slimdom.Element): TextNodeSpan[] => {
  const spans: TextNodeSpan[] = [];
  let position = 0;
  const walk = (node: slimdom.Node): void => {
    if (!isElement(node)) {
      return;
    }
    if (node.localName === "t" && node.namespaceURI === W_NS) {
      const length = (node.textContent ?? "").length;
      spans.push({ node, start: position, end: position + length });
      position += length;
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };
  walk(paragraph);
  return spans;
};

type InPlaceEdit = {
  node: slimdom.Element;
  from: number;
  to: number;
  value: string;
};

/**
 * Map each range to the single `w:t` that fully contains it. Returns `null` if
 * any range spans run boundaries (Word split that marker) — the caller then
 * routes the whole paragraph through the run-rebuild path so offsets stay in
 * one coordinate space.
 */
const asInPlaceEdits = (
  spans: readonly TextNodeSpan[],
  ranges: readonly NumberingRange[],
): InPlaceEdit[] | null => {
  const edits: InPlaceEdit[] = [];
  for (const range of ranges) {
    const span = spans.find(
      (candidate) =>
        range.start >= candidate.start && range.end <= candidate.end,
    );
    if (!span) {
      return null;
    }
    edits.push({
      node: span.node,
      from: range.start - span.start,
      to: range.end - span.start,
      value: range.value,
    });
  }
  return edits;
};

/**
 * Rewrite numbering marker ranges in a paragraph. When every range is
 * contiguous within one `w:t`, the markers are edited in place (no run is
 * split, so a contiguous marker's output matches the raw-XML pass byte for byte
 * and run formatting is untouched). If any range spans multiple runs (Word
 * split the marker), the whole paragraph is routed through
 * `replaceParagraphTextRanges`, which rebuilds the runs the same way the
 * placeholder patcher does. In-place edits are applied descending by offset so
 * earlier offsets stay valid; the split fallback sorts internally.
 */
const rewriteNumberingRanges = (
  paragraph: slimdom.Element,
  ranges: readonly NumberingRange[],
): void => {
  const edits = asInPlaceEdits(textNodeSpans(paragraph), ranges);
  if (!edits) {
    replaceParagraphTextRanges(paragraph, ranges);
    return;
  }
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    const text = edit.node.textContent ?? "";
    edit.node.textContent =
      text.slice(0, edit.from) + edit.value + text.slice(edit.to);
  }
};

/**
 * Assign sequential numbers to every `{{@num:Key}}` in `doc`, threading the
 * shared `numbers` map so the count continues across paragraphs and (when the
 * caller reuses the map) across parts. Paragraphs are visited in document
 * order; within a paragraph, markers are numbered left to right (ascending)
 * before the ranges are spliced back (descending), so assignment order matches
 * reading order regardless of splice order. Returns whether any marker matched.
 */
export const assignNumbersInDoc = (
  doc: slimdom.Document,
  numbers: Map<string, number>,
): boolean => {
  let changed = false;
  for (const paragraph of paragraphsOf(doc)) {
    const text = paragraphSpanText(paragraph);
    const ranges: NumberingRange[] = [];
    for (const match of text.matchAll(NUM_RE)) {
      const key = match[1];
      if (key === undefined) {
        continue;
      }
      const existing = numbers.get(key);
      const assigned = existing ?? numbers.size + 1;
      if (existing === undefined) {
        numbers.set(key, assigned);
      }
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        value: String(assigned),
      });
    }
    if (ranges.length > 0) {
      rewriteNumberingRanges(paragraph, ranges);
      changed = true;
    }
  }
  return changed;
};

/**
 * Resolve every `{{@ref:Key}}` in `doc` against `numbers`. An unresolved
 * reference (its `@num` was conditionally excluded, never existed, or lives in
 * another iteration) is left intact so it surfaces as an unmatched-placeholder
 * diagnostic rather than a wrong number. Returns whether any ref was resolved.
 */
export const resolveRefsInDoc = (
  doc: slimdom.Document,
  numbers: ReadonlyMap<string, number>,
): boolean => {
  let changed = false;
  for (const paragraph of paragraphsOf(doc)) {
    const text = paragraphSpanText(paragraph);
    const ranges: NumberingRange[] = [];
    for (const match of text.matchAll(REF_RE)) {
      const key = match[1];
      if (key === undefined) {
        continue;
      }
      const assigned = numbers.get(key);
      if (assigned === undefined) {
        continue;
      }
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        value: String(assigned),
      });
    }
    if (ranges.length > 0) {
      rewriteNumberingRanges(paragraph, ranges);
      changed = true;
    }
  }
  return changed;
};
