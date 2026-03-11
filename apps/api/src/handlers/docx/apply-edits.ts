/**
 * Core tracked-changes engine.
 *
 * Applies insert / delete / replace edits to a DOCX document.xml
 * string, wrapping changes in OOXML revision markup (`w:ins`,
 * `w:del`) so Microsoft Word displays them in review mode.
 *
 * Algorithm:
 * 1. Parse XML, index `w:p` elements and build char-offset maps.
 * 2. Sort edits in reverse document order (bottom-first) so
 *    earlier offsets aren't invalidated by later mutations.
 * 3. For each edit, locate the target `w:r`/`w:t`, split runs
 *    at boundaries, and wrap in revision markup.
 */

import * as slimdom from "slimdom";

import { isElement, W_NS } from "./ooxml";
import { buildRunMap } from "./run-map";
import type { RunSpan } from "./run-map";
import type { DocxEdit, RevisionAuthor, TextFormat } from "./types";

// ── Run splitting ─────────────────────────────────────────

/**
 * Clone `w:rPr` from a run if present, preserving formatting.
 * Reassigns `w:id` on `w:rPrChange` children when `idGenerator`
 * is provided; removes the attribute otherwise.
 */
const cloneRunProps = (
  run: slimdom.Element,
  idGenerator?: () => number,
): slimdom.Element | null => {
  for (const child of run.childNodes) {
    if (!isElement(child)) {
      continue;
    }
    if (child.localName === "rPr" && child.namespaceURI === W_NS) {
      const clone = child.cloneNode(true);
      if (!isElement(clone)) {
        continue;
      }
      for (const rprChild of clone.childNodes) {
        if (!isElement(rprChild)) {
          continue;
        }
        if (
          rprChild.localName === "rPrChange" &&
          rprChild.namespaceURI === W_NS
        ) {
          if (idGenerator) {
            rprChild.setAttributeNS(W_NS, "w:id", String(idGenerator()));
          } else {
            rprChild.removeAttributeNS(W_NS, "id");
          }
        }
      }
      return clone;
    }
  }
  return null;
};

/** Build run properties, merging existing rPr with format overrides. */
const buildRunProps = (
  doc: slimdom.Document,
  sourceRun: slimdom.Element | null,
  format?: TextFormat,
  idGenerator?: () => number,
): slimdom.Element | null => {
  const rPr = sourceRun ? cloneRunProps(sourceRun, idGenerator) : null;

  if (!format?.bold && !format?.italic) {
    return rPr;
  }

  const result = rPr ?? doc.createElementNS(W_NS, "w:rPr");
  if (format.bold && !result.getElementsByTagNameNS(W_NS, "b").length) {
    result.append(doc.createElementNS(W_NS, "w:b"));
  }
  if (format.italic && !result.getElementsByTagNameNS(W_NS, "i").length) {
    result.append(doc.createElementNS(W_NS, "w:i"));
  }
  return result;
};

const XML_NS = "http://www.w3.org/XML/1998/namespace";

const createT = (doc: slimdom.Document, text: string): slimdom.Element => {
  const t = doc.createElementNS(W_NS, "w:t");
  t.setAttributeNS(XML_NS, "xml:space", "preserve");
  t.textContent = text;
  return t;
};

const createRun = (
  doc: slimdom.Document,
  text: string,
  rPr: slimdom.Element | null,
): slimdom.Element => {
  const r = doc.createElementNS(W_NS, "w:r");
  if (rPr) {
    r.append(rPr);
  }
  r.append(createT(doc, text));
  return r;
};

const createDelText = (
  doc: slimdom.Document,
  text: string,
): slimdom.Element => {
  const dt = doc.createElementNS(W_NS, "w:delText");
  dt.setAttributeNS(XML_NS, "xml:space", "preserve");
  dt.textContent = text;
  return dt;
};

const createDelRun = (
  doc: slimdom.Document,
  text: string,
  rPr: slimdom.Element | null,
): slimdom.Element => {
  const r = doc.createElementNS(W_NS, "w:r");
  if (rPr) {
    r.append(rPr);
  }
  r.append(createDelText(doc, text));
  return r;
};

// ── Revision wrappers ─────────────────────────────────────

const createIns = (
  doc: slimdom.Document,
  id: number,
  author: RevisionAuthor,
  children: slimdom.Element[],
): slimdom.Element => {
  const ins = doc.createElementNS(W_NS, "w:ins");
  ins.setAttributeNS(W_NS, "w:id", String(id));
  ins.setAttributeNS(W_NS, "w:author", author.name);
  ins.setAttributeNS(W_NS, "w:date", author.date);
  for (const child of children) {
    ins.append(child);
  }
  return ins;
};

const createDel = (
  doc: slimdom.Document,
  id: number,
  author: RevisionAuthor,
  children: slimdom.Element[],
): slimdom.Element => {
  const del = doc.createElementNS(W_NS, "w:del");
  del.setAttributeNS(W_NS, "w:id", String(id));
  del.setAttributeNS(W_NS, "w:author", author.name);
  del.setAttributeNS(W_NS, "w:date", author.date);
  for (const child of children) {
    del.append(child);
  }
  return del;
};

/** True when a w:r still contains at least one w:t child. */
const runHasText = (run: slimdom.Element): boolean =>
  [...run.childNodes].some(
    (c) => isElement(c) && c.localName === "t" && c.namespaceURI === W_NS,
  );

// ── Run splitting for multi-w:t ──────────────────────────

/**
 * When a w:r contains multiple w:t nodes and an edit targets
 * a non-first w:t, fragments inserted before the run would
 * appear before unaffected preceding text, corrupting order.
 *
 * This helper splits unaffected preceding w:t nodes into a
 * separate run, preserving document order.
 */
const splitPrecedingSiblings = (
  doc: slimdom.Document,
  run: slimdom.Element,
  firstAffectedTNode: slimdom.Element,
  idGenerator: () => number,
) => {
  const preceding: slimdom.Element[] = [];
  for (const child of [...run.childNodes]) {
    if (!isElement(child)) {
      continue;
    }
    if (child === firstAffectedTNode) {
      break;
    }
    if (child.localName === "t" && child.namespaceURI === W_NS) {
      preceding.push(child);
    }
  }

  if (preceding.length === 0) {
    return;
  }

  const preRun = doc.createElementNS(W_NS, "w:r");
  const rPr = cloneRunProps(run, idGenerator);
  if (rPr) {
    preRun.append(rPr);
  }
  for (const t of preceding) {
    preRun.append(t);
  }
  run.parentNode?.insertBefore(preRun, run);
};

// ── Edit application ──────────────────────────────────────

const findAffectedSpans = (
  spans: RunSpan[],
  charOffset: number,
  length: number,
): { startIdx: number; endIdx: number } => {
  const end = charOffset + length;
  let startIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const spanEnd = span.start + span.length;
    if (startIdx === -1 && spanEnd > charOffset) {
      startIdx = i;
    }
    if (span.start < end) {
      endIdx = i;
    }
  }

  return { startIdx, endIdx };
};

const applyInsert = (
  doc: slimdom.Document,
  p: slimdom.Element,
  spans: RunSpan[],
  charOffset: number | undefined,
  text: string,
  format: TextFormat | undefined,
  idGenerator: () => number,
  author: RevisionAuthor,
) => {
  const makeIns = (sourceRun: slimdom.Element | null) => {
    const rPr = buildRunProps(doc, sourceRun, format, idGenerator);
    const newRun = createRun(doc, text, rPr);
    return createIns(doc, idGenerator(), author, [newRun]);
  };

  // Append at end if no offset or past all text
  const lastSpan = spans.at(-1);
  if (
    charOffset === undefined ||
    !lastSpan ||
    charOffset >= lastSpan.start + lastSpan.length
  ) {
    p.append(makeIns(lastSpan?.run ?? null));
    return;
  }

  // Insert at offset 0: before first run
  if (charOffset === 0) {
    const firstRun = spans[0].run;
    const parent = firstRun.parentNode ?? p;
    parent.insertBefore(makeIns(firstRun), firstRun);
    return;
  }

  // Find the span containing the offset
  for (const span of spans) {
    const spanEnd = span.start + span.length;
    if (charOffset >= span.start && charOffset < spanEnd) {
      const localOffset = charOffset - span.start;
      const fullText = span.tNode.textContent ?? "";

      // Isolate preceding w:t siblings so insertions
      // appear after them, not before.
      splitPrecedingSiblings(doc, span.run, span.tNode, idGenerator);

      if (localOffset === 0) {
        const parent = span.run.parentNode ?? p;
        parent.insertBefore(makeIns(span.run), span.run);
      } else {
        const before = fullText.slice(0, localOffset);
        const after = fullText.slice(localOffset);
        const beforeRun = createRun(
          doc,
          before,
          cloneRunProps(span.run, idGenerator),
        );
        const afterRun = createRun(
          doc,
          after,
          cloneRunProps(span.run, idGenerator),
        );
        const ins = makeIns(span.run);

        const parent = span.run.parentNode;
        if (parent) {
          parent.insertBefore(beforeRun, span.run);
          parent.insertBefore(ins, span.run);
          parent.insertBefore(afterRun, span.run);
          // Remove only the affected w:t node. A multi-w:t
          // run may have siblings that must be preserved.
          span.run.removeChild(span.tNode);
          if (!runHasText(span.run)) {
            parent.removeChild(span.run);
          }
        }
      }
      return;
    }
  }

  // Fallback: append at end
  p.append(makeIns(spans[0]?.run ?? null));
};

const applyDelete = (
  doc: slimdom.Document,
  _p: slimdom.Element,
  spans: RunSpan[],
  charOffset: number,
  length: number,
  idGenerator: () => number,
  author: RevisionAuthor,
) => {
  const { startIdx, endIdx } = findAffectedSpans(spans, charOffset, length);
  if (startIdx === -1 || endIdx === -1) {
    return;
  }

  // Pre-split: isolate affected w:t nodes from preceding
  // unaffected siblings to prevent text reordering.
  const splitRuns = new Set<slimdom.Element>();
  for (let i = startIdx; i <= endIdx; i++) {
    const span = spans[i];
    if (splitRuns.has(span.run)) {
      continue;
    }
    splitRuns.add(span.run);
    splitPrecedingSiblings(doc, span.run, span.tNode, idGenerator);
  }

  const end = charOffset + length;
  const nodesToRemove: slimdom.Node[] = [];
  const nodesToInsert: { node: slimdom.Node; before: slimdom.Node }[] = [];

  for (let i = startIdx; i <= endIdx; i++) {
    const span = spans[i];
    const spanEnd = span.start + span.length;
    const fullText = span.tNode.textContent ?? "";

    const delStart = Math.max(charOffset, span.start) - span.start;
    const delEnd = Math.min(end, spanEnd) - span.start;

    const beforeText = fullText.slice(0, delStart);
    const deletedText = fullText.slice(delStart, delEnd);
    const afterText = fullText.slice(delEnd);

    // Build replacement fragments
    const fragments: slimdom.Element[] = [];

    if (beforeText) {
      fragments.push(
        createRun(doc, beforeText, cloneRunProps(span.run, idGenerator)),
      );
    }

    if (deletedText) {
      const delRun = createDelRun(
        doc,
        deletedText,
        cloneRunProps(span.run, idGenerator),
      );
      fragments.push(createDel(doc, idGenerator(), author, [delRun]));
    }

    if (afterText) {
      fragments.push(
        createRun(doc, afterText, cloneRunProps(span.run, idGenerator)),
      );
    }

    for (const frag of fragments) {
      nodesToInsert.push({ node: frag, before: span.run });
    }
    // Remove the specific w:t node, not the entire w:r.
    // A single w:r may contain multiple w:t nodes; removing
    // the run would destroy text from unaffected siblings.
    nodesToRemove.push(span.tNode);
  }

  // Apply mutations: insert fragments then remove originals.
  // Use each node's parentNode so runs inside wrappers
  // (w:hyperlink, w:ins, etc.) are handled correctly.
  for (const { node, before } of nodesToInsert) {
    const parent = before.parentNode;
    if (parent) {
      parent.insertBefore(node, before);
    }
  }

  for (const node of nodesToRemove) {
    const parent = node.parentNode;
    if (parent) {
      parent.removeChild(node);
    }
  }

  // Clean up runs that lost all w:t children (empty shells
  // with only w:rPr remaining).
  const affectedRuns = new Set<slimdom.Element>();
  for (let i = startIdx; i <= endIdx; i++) {
    affectedRuns.add(spans[i].run);
  }
  for (const run of affectedRuns) {
    if (!run.parentNode) {
      continue;
    }
    if (!runHasText(run)) {
      run.parentNode.removeChild(run);
    }
  }
};

export const applyEdits = (
  documentXml: string,
  edits: DocxEdit[],
  author: RevisionAuthor,
  idGenerator: () => number,
): string => {
  const doc = slimdom.parseXmlDocument(documentXml);

  // Index all w:p elements in document order
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0];
  if (!body) {
    return documentXml;
  }

  const paragraphs: slimdom.Element[] = [];
  for (const child of body.childNodes) {
    if (!isElement(child)) {
      continue;
    }
    if (child.localName === "p" && child.namespaceURI === W_NS) {
      paragraphs.push(child);
    }
  }

  // Sort edits in reverse document order: highest paragraph index
  // first, then highest charOffset first within the same paragraph
  const sorted = [...edits].toSorted((a, b) => {
    if (a.paragraphIndex !== b.paragraphIndex) {
      return b.paragraphIndex - a.paragraphIndex;
    }
    const aOffset =
      a.kind === "insert"
        ? (a.charOffset ?? Number.MAX_SAFE_INTEGER)
        : a.charOffset;
    const bOffset =
      b.kind === "insert"
        ? (b.charOffset ?? Number.MAX_SAFE_INTEGER)
        : b.charOffset;
    return bOffset - aOffset;
  });

  for (const edit of sorted) {
    const p = paragraphs[edit.paragraphIndex];
    if (!p) {
      continue;
    }

    // Rebuild the run map for each edit (previous edits may
    // have changed the DOM)
    const spans = buildRunMap(p);

    switch (edit.kind) {
      case "insert":
        applyInsert(
          doc,
          p,
          spans,
          edit.charOffset,
          edit.text,
          edit.format,
          idGenerator,
          author,
        );
        break;

      case "delete":
        applyDelete(
          doc,
          p,
          spans,
          edit.charOffset,
          edit.length,
          idGenerator,
          author,
        );
        break;

      case "replace": {
        applyDelete(
          doc,
          p,
          spans,
          edit.charOffset,
          edit.length,
          idGenerator,
          author,
        );
        const newSpans = buildRunMap(p);
        applyInsert(
          doc,
          p,
          newSpans,
          edit.charOffset,
          edit.text,
          edit.format,
          idGenerator,
          author,
        );
        break;
      }

      default:
        break;
    }
  }

  return slimdom.serializeToWellFormedString(doc);
};
