/**
 * Inject comments into a DOCX document.
 *
 * Each comment anchors to a character range in a paragraph via
 * `w:commentRangeStart`, `w:commentRangeEnd`, and
 * `w:commentReference` elements in document.xml. The comment
 * content lives in a separate `word/comments.xml` part.
 */

import * as slimdom from "slimdom";

import { ParseXmlError } from "@/api/lib/errors/tagged-errors";

import { isElement, W_NS } from "./ooxml";
import { buildRunMap } from "./run-map";
import type { RunSpan } from "./run-map";
import type { DocxComment, RevisionAuthor } from "./types";

const XML_NS = "http://www.w3.org/XML/1998/namespace";

// ── Helpers ───────────────────────────────────────────────

const findSpanAt = (
  spans: RunSpan[],
  charOffset: number,
): { span: RunSpan; localOffset: number } | null => {
  for (const span of spans) {
    if (charOffset >= span.start && charOffset < span.start + span.length) {
      return { span, localOffset: charOffset - span.start };
    }
  }
  return null;
};

const findSpanEnd = (
  spans: RunSpan[],
  charOffset: number,
  length: number,
): RunSpan | null => {
  const endOffset = charOffset + length - 1;
  for (const span of spans) {
    if (endOffset >= span.start && endOffset < span.start + span.length) {
      return span;
    }
  }
  return null;
};

/** Walk up to the direct child of `p` (handles deeply nested wrappers). */
const anchorOf = (run: slimdom.Element, p: slimdom.Element): slimdom.Node => {
  let node: slimdom.Node = run;
  while (node.parentNode && node.parentNode !== p) {
    node = node.parentNode;
  }
  return node;
};

// ── Comment injection into document.xml ───────────────────

const injectAnchors = (
  doc: slimdom.Document,
  paragraphs: slimdom.Element[],
  comments: DocxComment[],
  idGenerator: () => number,
): { anchoredComments: DocxComment[]; commentIds: number[] } => {
  const anchoredComments: DocxComment[] = [];
  const commentIds: number[] = [];

  for (const comment of comments) {
    const p = paragraphs.at(comment.paragraphIndex);
    if (!p) {
      continue;
    }

    const spans = buildRunMap(p);
    const commentId = idGenerator();
    anchoredComments.push(comment);
    commentIds.push(commentId);

    // Create range start
    const rangeStart = doc.createElementNS(W_NS, "w:commentRangeStart");
    rangeStart.setAttributeNS(W_NS, "w:id", String(commentId));

    // Create range end
    const rangeEnd = doc.createElementNS(W_NS, "w:commentRangeEnd");
    rangeEnd.setAttributeNS(W_NS, "w:id", String(commentId));

    // Create comment reference run
    const refRun = doc.createElementNS(W_NS, "w:r");
    const refRPr = doc.createElementNS(W_NS, "w:rPr");
    const refStyle = doc.createElementNS(W_NS, "w:rStyle");
    refStyle.setAttributeNS(W_NS, "w:val", "CommentReference");
    refRPr.append(refStyle);
    refRun.append(refRPr);
    const ref = doc.createElementNS(W_NS, "w:commentReference");
    ref.setAttributeNS(W_NS, "w:id", String(commentId));
    refRun.append(ref);

    // Position the anchors
    const startResult = findSpanAt(spans, comment.charOffset);
    const endSpan = findSpanEnd(spans, comment.charOffset, comment.length);

    if (startResult && endSpan) {
      const startAnchor = anchorOf(startResult.span.run, p);
      p.insertBefore(rangeStart, startAnchor);

      const endAnchor = anchorOf(endSpan.run, p);
      if (endAnchor.nextSibling) {
        p.insertBefore(rangeEnd, endAnchor.nextSibling);
        p.insertBefore(refRun, rangeEnd.nextSibling);
      } else {
        p.append(rangeEnd);
        p.append(refRun);
      }
    } else {
      // Fallback: append at end of paragraph
      p.append(rangeStart);
      p.append(rangeEnd);
      p.append(refRun);
    }
  }

  return { anchoredComments, commentIds };
};

// ── Comments XML ──────────────────────────────────────────

/**
 * Build or merge a `word/comments.xml` part.
 */
const buildCommentsXml = (
  existingXml: string | null,
  comments: DocxComment[],
  commentIds: number[],
  author: RevisionAuthor,
): string => {
  let doc: slimdom.Document;
  let commentsEl: slimdom.Element;

  if (existingXml) {
    doc = slimdom.parseXmlDocument(existingXml);
    const root = doc.documentElement;
    if (!root) {
      throw new ParseXmlError({
        message: "Malformed comments.xml: no root element",
        cause: existingXml,
      });
    }
    commentsEl = root;
  } else {
    doc = new slimdom.Document();
    commentsEl = doc.createElementNS(W_NS, "w:comments");
    commentsEl.setAttributeNS("http://www.w3.org/2000/xmlns/", "xmlns:w", W_NS);
    commentsEl.setAttributeNS(
      "http://www.w3.org/2000/xmlns/",
      "xmlns:r",
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    );
    doc.append(commentsEl);
  }

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    if (!comment) {
      continue;
    }
    const id = commentIds[i];

    const commentEl = doc.createElementNS(W_NS, "w:comment");
    commentEl.setAttributeNS(W_NS, "w:id", String(id));
    commentEl.setAttributeNS(W_NS, "w:author", author.name);
    commentEl.setAttributeNS(W_NS, "w:date", author.date);
    commentEl.setAttributeNS(W_NS, "w:initials", author.name.at(0) ?? "?");

    // Comment body: a single paragraph with the comment text
    const p = doc.createElementNS(W_NS, "w:p");
    const r = doc.createElementNS(W_NS, "w:r");
    const t = doc.createElementNS(W_NS, "w:t");
    t.setAttributeNS(XML_NS, "xml:space", "preserve");
    t.textContent = comment.text;
    r.append(t);
    p.append(r);
    commentEl.append(p);

    commentsEl.append(commentEl);
  }

  return slimdom.serializeToWellFormedString(doc);
};

// ── Public API ────────────────────────────────────────────

export const injectComments = (
  documentXml: string,
  commentsXml: string | null,
  comments: DocxComment[],
  author: RevisionAuthor,
  idGenerator: () => number,
): { documentXml: string; commentsXml: string } => {
  const doc = slimdom.parseXmlDocument(documentXml);

  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);
  if (!body) {
    return {
      documentXml,
      commentsXml: buildCommentsXml(commentsXml, [], [], author),
    };
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

  const { anchoredComments, commentIds } = injectAnchors(
    doc,
    paragraphs,
    comments,
    idGenerator,
  );

  return {
    documentXml: slimdom.serializeToWellFormedString(doc),
    commentsXml: buildCommentsXml(
      commentsXml,
      anchoredComments,
      commentIds,
      author,
    ),
  };
};
