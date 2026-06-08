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

  if (value.paragraphs.length <= 1) {
    return (value.paragraphs.at(0)?.runs ?? []).map((run) =>
      createRun(doc, run.text, sourceRunProps, run),
    );
  }

  return [createRun(doc, valueText(value), sourceRunProps)];
};

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
