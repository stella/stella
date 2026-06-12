/**
 * Owned OOXML placeholder patching for DOCX templates.
 *
 * It operates on WordprocessingML directly so the server owns the
 * transformation surface: placeholders are discovered from paragraph
 * text, including split runs, then rewritten into deterministic
 * `w:r` / `w:t` XML.
 */

import * as slimdom from "slimdom";

import { placeholderPattern } from "@stll/template-conditions";

import { isElement, paragraphText, W_NS } from "./ooxml";
import type { RichPatchValue } from "./types";

// Canonical pattern from @stll/template-conditions (markers.ts) — the single
// source of truth shared with discover-placeholders, folio, and the web preview.
export const PLACEHOLDER_RE = placeholderPattern();

const XML_NS = "http://www.w3.org/XML/1998/namespace";

const valueText = (value: RichPatchValue): string => {
  if (typeof value === "string") {
    return value;
  }

  return value.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
    .join("\n");
};

const isStandalonePlaceholder = (
  text: string,
  values: Record<string, RichPatchValue>,
): { key: string; value: RichPatchValue } | null => {
  const matches = [...text.matchAll(PLACEHOLDER_RE)];
  const match = matches.at(0);
  if (
    !match ||
    matches.length > 1 ||
    match[0] !== text ||
    match[1] === undefined
  ) {
    return null;
  }

  const value = values[match[1]];
  return value === undefined ? null : { key: match[1], value };
};

export const replacePlaceholdersInText = (
  text: string,
  values: Record<string, RichPatchValue>,
): { text: string; changed: boolean } => {
  let changed = false;
  PLACEHOLDER_RE.lastIndex = 0;
  const nextText = text.replaceAll(PLACEHOLDER_RE, (placeholder, key) => {
    const value = values[String(key)];
    if (value === undefined) {
      return placeholder;
    }

    changed = true;
    return valueText(value);
  });

  return { text: nextText, changed };
};

const cloneRunProps = (run: slimdom.Element): slimdom.Element | null => {
  for (const child of run.childNodes) {
    if (
      isElement(child) &&
      child.localName === "rPr" &&
      child.namespaceURI === W_NS
    ) {
      const clone = child.cloneNode(true);
      return isElement(clone) ? clone : null;
    }
  }
  return null;
};

const cloneElement = (
  element: slimdom.Element | null,
): slimdom.Element | null => {
  if (!element) {
    return null;
  }
  const clone = element.cloneNode(true);
  return isElement(clone) ? clone : null;
};

const firstRunProps = (paragraph: slimdom.Element): slimdom.Element | null => {
  const runs = paragraph.getElementsByTagNameNS(W_NS, "r");
  const firstRun = runs.at(0);
  return firstRun ? cloneRunProps(firstRun) : null;
};

const nearestRun = (node: slimdom.Node): slimdom.Element | null => {
  let current: slimdom.Node | null = node.parentNode;
  while (current) {
    if (
      isElement(current) &&
      current.localName === "r" &&
      current.namespaceURI === W_NS
    ) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
};

type TextSpan = {
  node: slimdom.Element;
  run: slimdom.Element;
  start: number;
  end: number;
  text: string;
};

const collectTextSpans = (paragraph: slimdom.Element): TextSpan[] => {
  const spans: TextSpan[] = [];
  let position = 0;

  const walk = (node: slimdom.Node) => {
    if (!isElement(node)) {
      return;
    }

    if (node.localName === "t" && node.namespaceURI === W_NS) {
      const run = nearestRun(node);
      if (!run) {
        return;
      }
      const text = node.textContent ?? "";
      spans.push({
        node,
        run,
        start: position,
        end: position + text.length,
        text,
      });
      position += text.length;
      return;
    }

    for (const child of node.childNodes) {
      walk(child);
    }
  };

  walk(paragraph);
  return spans;
};

const createText = (doc: slimdom.Document, text: string): slimdom.Element => {
  const t = doc.createElementNS(W_NS, "w:t");
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
  t.textContent = text;
  return t;
};

const applyInlineFormat = (
  doc: slimdom.Document,
  rPr: slimdom.Element | null,
  run: { bold?: boolean; italic?: boolean },
): slimdom.Element | null => {
  if (!run.bold && !run.italic) {
    return rPr;
  }

  const result = rPr ?? doc.createElementNS(W_NS, "w:rPr");
  if (run.bold && !result.getElementsByTagNameNS(W_NS, "b").length) {
    result.append(doc.createElementNS(W_NS, "w:b"));
  }
  if (run.italic && !result.getElementsByTagNameNS(W_NS, "i").length) {
    result.append(doc.createElementNS(W_NS, "w:i"));
  }
  return result;
};

const createRun = (
  doc: slimdom.Document,
  text: string,
  rPr: slimdom.Element | null,
  format: { bold?: boolean; italic?: boolean } = {},
): slimdom.Element => {
  const run = doc.createElementNS(W_NS, "w:r");
  const props = applyInlineFormat(doc, cloneElement(rPr), format);
  if (props) {
    run.append(props);
  }
  run.append(createText(doc, text));
  return run;
};

const createInlineRuns = (
  doc: slimdom.Document,
  value: RichPatchValue,
  sourceRunProps: slimdom.Element | null,
): slimdom.Element[] => {
  if (typeof value === "string") {
    return [createRun(doc, value, sourceRunProps)];
  }

  // Single-paragraph values stay inline; multi-paragraph values are handled
  // by the paragraph-splitting path (see splitParagraphForBlockValues) and
  // never reach this function. If one does (defensive), join its text so the
  // run-replacement path stays well-formed rather than dropping content.
  if (value.paragraphs.length <= 1) {
    return (value.paragraphs.at(0)?.runs ?? []).map((run) =>
      createRun(doc, run.text, sourceRunProps, run),
    );
  }

  return [createRun(doc, valueText(value), sourceRunProps)];
};

const isMultiParagraphValue = (value: RichPatchValue): boolean =>
  typeof value !== "string" && value.paragraphs.length > 1;

const paragraphProps = (paragraph: slimdom.Element): slimdom.Element | null => {
  for (const child of paragraph.childNodes) {
    if (
      isElement(child) &&
      child.localName === "pPr" &&
      child.namespaceURI === W_NS
    ) {
      const clone = child.cloneNode(true);
      return isElement(clone) ? clone : null;
    }
  }
  return null;
};

const clearParagraphContent = (paragraph: slimdom.Element) => {
  for (const child of [...paragraph.childNodes]) {
    if (
      isElement(child) &&
      child.localName === "pPr" &&
      child.namespaceURI === W_NS
    ) {
      continue;
    }
    paragraph.removeChild(child);
  }
};

const setText = (node: slimdom.Element, text: string) => {
  node.setAttributeNS(XML_NS, "xml:space", "preserve");
  node.textContent = text;
};

const richParagraphs = (
  value: RichPatchValue,
): { runs: { text: string; bold?: boolean; italic?: boolean }[] }[] => {
  if (typeof value === "string") {
    return [{ runs: [{ text: value }] }];
  }
  return value.paragraphs;
};

const createParagraph = (
  doc: slimdom.Document,
  sourceParagraph: slimdom.Element,
  runs: { text: string; bold?: boolean; italic?: boolean }[],
): slimdom.Element => {
  const paragraph = doc.createElementNS(W_NS, "w:p");
  const pPr = paragraphProps(sourceParagraph);
  if (pPr) {
    paragraph.append(pPr);
  }
  const sourceRunProps = firstRunProps(sourceParagraph);
  for (const run of runs) {
    paragraph.append(createRun(doc, run.text, sourceRunProps, run));
  }
  return paragraph;
};

const setStandaloneValue = (
  paragraph: slimdom.Element,
  value: RichPatchValue,
) => {
  const doc = paragraph.ownerDocument;
  if (!doc) {
    return;
  }

  const paragraphs = richParagraphs(value);
  if (paragraphs.length <= 1) {
    const sourceRunProps = firstRunProps(paragraph);
    clearParagraphContent(paragraph);
    for (const run of paragraphs.at(0)?.runs ?? []) {
      paragraph.append(createRun(doc, run.text, sourceRunProps, run));
    }
    return;
  }

  const parent = paragraph.parentNode;
  if (!parent) {
    return;
  }

  for (const richParagraph of paragraphs) {
    parent.insertBefore(
      createParagraph(doc, paragraph, richParagraph.runs),
      paragraph,
    );
  }
  parent.removeChild(paragraph);
};

type PlaceholderMatch = {
  start: number;
  end: number;
  value: RichPatchValue;
};

const findPlaceholderMatches = (
  text: string,
  values: Record<string, RichPatchValue>,
): PlaceholderMatch[] => {
  const matches: PlaceholderMatch[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const key = match[1];
    if (!key) {
      continue;
    }
    const value = values[key];
    if (value === undefined) {
      continue;
    }
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      value,
    });
  }
  return matches;
};

const spanForOffset = (spans: TextSpan[], offset: number): TextSpan | null =>
  spans.find((span) => offset >= span.start && offset < span.end) ??
  spans.find((span) => offset === span.end && span.start !== span.end) ??
  null;

const insertAfter = (
  parent: slimdom.Node,
  reference: slimdom.Node,
  nodes: slimdom.Element[],
) => {
  const before = reference.nextSibling;
  for (const node of nodes) {
    parent.insertBefore(node, before);
  }
};

const directRunChildForNode = (
  run: slimdom.Element,
  node: slimdom.Node,
): slimdom.Node | null => {
  let current: slimdom.Node | null = node;
  while (current && current.parentNode !== run) {
    current = current.parentNode;
  }
  return current?.parentNode === run ? current : null;
};

const createSameRunTrailingRun = ({
  doc,
  endNode,
  run,
  sourceRunProps,
  startNode,
  suffix,
}: {
  doc: slimdom.Document;
  endNode: slimdom.Element;
  run: slimdom.Element;
  sourceRunProps: slimdom.Element | null;
  startNode: slimdom.Element;
  suffix: string;
}): slimdom.Element | null => {
  const trailingRun = doc.createElementNS(W_NS, "w:r");
  const props = cloneElement(sourceRunProps);
  if (props) {
    trailingRun.append(props);
  }

  let hasContent = false;
  if (suffix.length > 0) {
    trailingRun.append(createText(doc, suffix));
    hasContent = true;
  }

  const startChild = directRunChildForNode(run, startNode);
  const endChild = directRunChildForNode(run, endNode);
  if (!startChild || !endChild) {
    return hasContent ? trailingRun : null;
  }

  let trailingChild = endChild.nextSibling;
  while (trailingChild) {
    const next = trailingChild.nextSibling;
    trailingRun.appendChild(trailingChild);
    hasContent = true;
    trailingChild = next;
  }

  if (startChild !== endChild) {
    let childToRemove = startChild.nextSibling;
    while (childToRemove) {
      const next = childToRemove.nextSibling;
      run.removeChild(childToRemove);
      if (childToRemove === endChild) {
        break;
      }
      childToRemove = next;
    }
  }

  return hasContent ? trailingRun : null;
};

const applyInlineMatch = (
  paragraph: slimdom.Element,
  spans: TextSpan[],
  match: PlaceholderMatch,
) => {
  const doc = paragraph.ownerDocument;
  if (!doc) {
    return;
  }

  const startSpan = spanForOffset(spans, match.start);
  const endSpan = spanForOffset(spans, match.end - 1);
  if (!startSpan || !endSpan) {
    return;
  }

  const prefix = startSpan.text.slice(0, match.start - startSpan.start);
  const suffix = endSpan.text.slice(match.end - endSpan.start);
  const sameRunMatch = startSpan.run === endSpan.run;
  setText(startSpan.node, prefix);

  if (endSpan !== startSpan) {
    let insideRange = false;
    for (const span of spans) {
      if (span === startSpan) {
        insideRange = true;
        continue;
      }
      if (!insideRange) {
        continue;
      }
      if (span === endSpan) {
        break;
      }
      setText(span.node, "");
    }
    setText(endSpan.node, sameRunMatch ? "" : suffix);
  }

  const sourceRunProps = cloneRunProps(startSpan.run);
  const replacementRuns = createInlineRuns(doc, match.value, sourceRunProps);

  if (sameRunMatch) {
    const trailingRun = createSameRunTrailingRun({
      doc,
      endNode: endSpan.node,
      run: startSpan.run,
      sourceRunProps,
      startNode: startSpan.node,
      suffix,
    });
    if (trailingRun) {
      replacementRuns.push(trailingRun);
    }
  }

  const parent = startSpan.run.parentNode;
  if (!parent) {
    return;
  }
  insertAfter(parent, startSpan.run, replacementRuns);
};

/**
 * Text of one paragraph as the patcher's span walk sees it (every `w:t`
 * inside a `w:r`, concatenated in document order). Offsets into this text
 * are the coordinate space of {@link replaceParagraphTextRanges}; compute
 * ranges from this, not from `paragraphText`, so they can never drift apart.
 */
export const paragraphSpanText = (paragraph: slimdom.Element): string =>
  collectTextSpans(paragraph)
    .map((span) => span.text)
    .join("");

/**
 * Replace arbitrary non-overlapping, non-empty `[start, end)` ranges of a
 * paragraph's span text (see {@link paragraphSpanText}) with plain-string
 * values, reusing the same run-splitting machinery as placeholder patching:
 * surrounding run formatting is preserved and ranges spanning split runs are
 * handled. An empty value cuts the range. Ranges are applied descending by
 * start so earlier offsets stay valid throughout.
 */
export const replaceParagraphTextRanges = (
  paragraph: slimdom.Element,
  ranges: readonly { start: number; end: number; value: string }[],
): void => {
  for (const range of [...ranges].toSorted((a, b) => b.start - a.start)) {
    applyInlineMatch(paragraph, collectTextSpans(paragraph), range);
  }
};

/**
 * Deep-clone the run sequence covering `[contentStart, contentEnd)` of a
 * paragraph's span text, trimming the boundary runs to the in-span slice while
 * keeping every run's `rPr`. Returns the cloned `w:r` elements in document
 * order; runs lying entirely inside the span are cloned whole, the first/last
 * run is cloned with its text sliced to the part that falls inside the span.
 * An empty span (no text spans intersect it) yields an empty array.
 *
 * The clones are detached (no parent); the caller owns insertion. Boundary
 * `w:t` nodes keep `xml:space="preserve"` so leading/trailing whitespace inside
 * the body (author separators) survives.
 */
const cloneRunSequence = (
  spans: readonly TextSpan[],
  contentStart: number,
  contentEnd: number,
): slimdom.Element[] => {
  const clones: slimdom.Element[] = [];
  for (const span of spans) {
    const from = Math.max(span.start, contentStart);
    const to = Math.min(span.end, contentEnd);
    if (from >= to) {
      continue;
    }
    const runClone = span.run.cloneNode(true);
    if (!isElement(runClone)) {
      continue;
    }
    const slice = span.text.slice(from - span.start, to - span.start);
    // A run can hold several `w:t` (one span each). Index the span's `w:t`
    // within its run, then rewrite the same position in the clone and clear the
    // other `w:t`s so this clone carries exactly this span's in-span slice.
    const tIndex = span.run
      .getElementsByTagNameNS(W_NS, "t")
      .indexOf(span.node);
    const clonedTs = runClone.getElementsByTagNameNS(W_NS, "t");
    for (const [i, t] of clonedTs.entries()) {
      setText(t, i === tIndex ? slice : "");
    }
    clones.push(runClone);
  }
  return clones;
};

/**
 * Render an inline `{{#each}}` span at the run level, preserving run formatting
 * authored inside the body. For each item, the body run sequence
 * (`[contentStart, contentEnd)` of the paragraph span text) is deep-cloned and
 * each cloned run's text is rewritten by `rewriteItem(text, itemIndex)`; the
 * concatenated per-item clones replace the whole marker span (`[start, end)`),
 * so the opener/closer marker runs are removed. `itemCount === 0` removes the
 * span entirely. Offsets index {@link paragraphSpanText}; this must run before
 * the paragraph is otherwise mutated for the same span.
 */
export const expandInlineEachRuns = (
  paragraph: slimdom.Element,
  range: {
    start: number;
    end: number;
    contentStart: number;
    contentEnd: number;
  },
  itemCount: number,
  rewriteItem: (text: string, itemIndex: number) => string,
): void => {
  const spans = collectTextSpans(paragraph);

  const replacementRuns: slimdom.Element[] = [];
  for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
    for (const runClone of cloneRunSequence(
      spans,
      range.contentStart,
      range.contentEnd,
    )) {
      for (const t of runClone.getElementsByTagNameNS(W_NS, "t")) {
        const text = t.textContent ?? "";
        const rewritten = rewriteItem(text, itemIdx);
        if (rewritten !== text) {
          setText(t, rewritten);
        }
      }
      replacementRuns.push(runClone);
    }
  }

  // Cut the whole marker span (markers + body) out of the original runs, then
  // splice the expanded copies in at the cut point. Reuse applyInlineMatch with
  // an empty value: it preserves surrounding run formatting and leaves an
  // anchor (the start span's run) we insert the clones after.
  const anchor = spanForOffset(spans, range.start);
  applyInlineMatch(paragraph, collectTextSpans(paragraph), {
    start: range.start,
    end: range.end,
    value: "",
  });
  if (!anchor) {
    return;
  }
  const parent = anchor.run.parentNode;
  if (!parent) {
    return;
  }
  insertAfter(parent, anchor.run, replacementRuns);
};

/**
 * Inline injection of a multi-paragraph value (e.g. a multi-paragraph library
 * clause filling a mid-paragraph `{{@clause:Name}}` slot). The host paragraph
 * is split: text before the first multi-paragraph marker stays in a leading
 * paragraph, each clause paragraph becomes its own `w:p`, and text after the
 * marker trails into a final paragraph. Every produced paragraph clones the
 * host `pPr` (style ref, numbering, alignment, spacing) and the host's first
 * run `rPr`, so the injected block inherits the target paragraph's style.
 *
 * Single-paragraph and string matches in the same paragraph are still rendered
 * inline (as runs) within whichever produced paragraph they fall into; only a
 * multi-paragraph match introduces a paragraph break. Markers without a value
 * stay as literal text.
 */
const splitParagraphForBlockValues = (
  paragraph: slimdom.Element,
  text: string,
  matches: PlaceholderMatch[],
): boolean => {
  const doc = paragraph.ownerDocument;
  const parent = paragraph.parentNode;
  if (!doc || !parent) {
    return false;
  }

  const pPr = paragraphProps(paragraph);
  const sourceRunProps = firstRunProps(paragraph);

  const newParagraph = (): slimdom.Element => {
    const next = doc.createElementNS(W_NS, "w:p");
    const props = cloneElement(pPr);
    if (props) {
      next.append(props);
    }
    return next;
  };

  const built: slimdom.Element[] = [];
  // The paragraph being accumulated. Leading/trailing/inline text and
  // single-paragraph values append runs here; a multi-paragraph value flushes
  // it, emits the clause paragraphs, then opens a fresh accumulator.
  let current = newParagraph();

  const appendText = (chunk: string) => {
    if (chunk.length === 0) {
      return;
    }
    current.append(createRun(doc, chunk, sourceRunProps));
  };

  let cursor = 0;
  for (const match of matches) {
    appendText(text.slice(cursor, match.start));
    cursor = match.end;

    const { value } = match;
    if (typeof value === "string" || value.paragraphs.length <= 1) {
      for (const run of createInlineRuns(doc, value, sourceRunProps)) {
        current.append(run);
      }
      continue;
    }

    built.push(current);
    for (const clauseParagraph of value.paragraphs) {
      const next = newParagraph();
      for (const run of clauseParagraph.runs) {
        next.append(createRun(doc, run.text, sourceRunProps, run));
      }
      built.push(next);
    }
    current = newParagraph();
  }
  appendText(text.slice(cursor));
  built.push(current);

  // Drop empty leading/trailing fragments (e.g. an empty clause value, or a
  // marker that opened/closed the paragraph) but never collapse to nothing:
  // an all-empty result still leaves one paragraph to preserve structure.
  const nonEmpty = built.filter(
    (candidate) => candidate.getElementsByTagNameNS(W_NS, "r").length > 0,
  );
  const emit = nonEmpty.length > 0 ? nonEmpty : built.slice(0, 1);

  for (const produced of emit) {
    parent.insertBefore(produced, paragraph);
  }
  parent.removeChild(paragraph);
  return true;
};

const patchInlinePlaceholders = (
  paragraph: slimdom.Element,
  values: Record<string, RichPatchValue>,
): boolean => {
  const spans = collectTextSpans(paragraph);
  const text = spans.map((span) => span.text).join("");
  const matches = findPlaceholderMatches(text, values);
  if (matches.length === 0) {
    return false;
  }

  if (matches.some((match) => isMultiParagraphValue(match.value))) {
    return splitParagraphForBlockValues(paragraph, text, matches);
  }

  for (const match of matches.toReversed()) {
    applyInlineMatch(paragraph, collectTextSpans(paragraph), match);
  }

  return true;
};

export const patchParagraphPlaceholders = (
  paragraph: slimdom.Element,
  values: Record<string, RichPatchValue>,
): boolean => {
  const text = paragraphText(paragraph);
  const standalone = isStandalonePlaceholder(text, values);
  if (standalone) {
    setStandaloneValue(paragraph, standalone.value);
    return true;
  }

  return patchInlinePlaceholders(paragraph, values);
};

export const patchXmlPart = (
  xml: string,
  values: Record<string, RichPatchValue>,
): { xml: string; changed: boolean } => {
  const doc = slimdom.parseXmlDocument(xml);
  const paragraphs = [...doc.getElementsByTagNameNS(W_NS, "p")];
  let changed = false;

  for (const paragraph of paragraphs) {
    changed = patchParagraphPlaceholders(paragraph, values) || changed;
  }

  return {
    xml: changed ? slimdom.serializeToWellFormedString(doc) : xml,
    changed,
  };
};

/**
 * Text of every paragraph in an XML part, in document order, computed from
 * the same text spans the patcher walks. Occurrence-indexed substitution
 * (`patchXmlPartPerOccurrence`) counts marker occurrences against exactly
 * this text, so context extraction and patching can never drift apart.
 */
export const partParagraphTexts = (xml: string): string[] => {
  const doc = slimdom.parseXmlDocument(xml);
  return [...doc.getElementsByTagNameNS(W_NS, "p")].map((paragraph) =>
    collectTextSpans(paragraph)
      .map((span) => span.text)
      .join(""),
  );
};

/**
 * Replace placeholders occurrence-by-occurrence: the nth occurrence of
 * `{{key}}` (in document order, counted across parts via the shared
 * `counters` map) is replaced with `occurrenceValues.get(key)[n]`. Keys
 * absent from the map and occurrences beyond the provided list are left
 * untouched, so the regular global fill can still substitute them.
 */
export const patchXmlPartPerOccurrence = (
  xml: string,
  occurrenceValues: ReadonlyMap<string, readonly string[]>,
  counters: Map<string, number>,
): { xml: string; changed: boolean } => {
  const doc = slimdom.parseXmlDocument(xml);
  const paragraphs = [...doc.getElementsByTagNameNS(W_NS, "p")];
  let changed = false;

  for (const paragraph of paragraphs) {
    const text = collectTextSpans(paragraph)
      .map((span) => span.text)
      .join("");
    const matches: PlaceholderMatch[] = [];
    for (const match of text.matchAll(placeholderPattern())) {
      const key = match[1];
      if (key === undefined) {
        continue;
      }
      const renderings = occurrenceValues.get(key);
      if (renderings === undefined) {
        continue;
      }
      const index = counters.get(key) ?? 0;
      counters.set(key, index + 1);
      const value = renderings.at(index);
      if (value === undefined) {
        continue;
      }
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        value,
      });
    }
    if (matches.length === 0) {
      continue;
    }
    for (const match of matches.toReversed()) {
      applyInlineMatch(paragraph, collectTextSpans(paragraph), match);
    }
    changed = true;
  }

  return {
    xml: changed ? slimdom.serializeToWellFormedString(doc) : xml,
    changed,
  };
};
