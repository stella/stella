/**
 * Server-side DOCX → folio block extractor for the AI extraction
 * workflow.
 *
 * The chat path produces `FolioAIBlock`s from a live folio editor by
 * walking the ProseMirror tree; that's the canonical implementation
 * but it can't run server-side without dragging the editor's DOM
 * dependencies through TypeScript. This file mirrors the same block
 * shape (id format, kind detection, displayLabel rules) directly
 * against the DOCX XML so the AI prompt and frontend renderer agree
 * on the data they're exchanging.
 *
 * Phase 1 feature parity with the chat snapshot:
 *  - sequential `b-NNNN` IDs in document order
 *  - one block per paragraph; empty paragraphs are dropped
 *  - kind = "heading" | "listItem" | "paragraph"
 *  - listItem displayLabel = list marker text when present
 *  - heading displayLabel = "headingN" when the style id matches
 *  - tracked insertions/deletions and comments are preserved as inline tags
 */

import type { FolioAIBlock } from "@stll/folio/server";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import {
  renderDocxCommentMarkup,
  renderDocxDeletionMarkup,
  renderDocxInsertionMarkup,
} from "@/api/lib/docx-review-markup";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const EMPTY_COMMENT_IDS: ReadonlySet<string> = new Set();
const DOCX_HEADER_RE = /^word\/header\d+\.xml$/;
const DOCX_FOOTER_RE = /^word\/footer\d+\.xml$/;

const elementsByLocalName = (
  parent: slimdom.Element | slimdom.Document,
  localName: string,
): slimdom.Element[] =>
  parent
    .getElementsByTagNameNS(W_NS, localName)
    .filter((node): node is slimdom.Element => node.nodeType === 1);

const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";

type DocxComment = {
  author: string;
  date?: string;
  initials?: string;
  status?: "open" | "resolved";
  text: string;
  thread?: "root" | "reply";
};

type DocxReviewMetadata = {
  author?: string;
  date?: string;
  initials?: string;
};

type CommentExtendedMetadata = {
  status?: "open" | "resolved";
  thread?: "root" | "reply";
};

// Subtrees we never descend into when collecting paragraph text:
// `mc:Fallback` is the legacy branch of `mc:AlternateContent`.
// The preferred branch lives in a sibling `mc:Choice`; visiting both
// would emit the same text twice for compatibility-wrapped content.
const isSkippableSubtree = (element: slimdom.Element): boolean => {
  if (element.namespaceURI === MC_NS) {
    return element.localName === "Fallback";
  }
  return false;
};

const readWAttr = (element: slimdom.Element, localName: string) =>
  element.getAttributeNS(W_NS, localName) ??
  element.getAttribute(`w:${localName}`) ??
  undefined;

const readWordAttr = (element: slimdom.Element, localName: string) =>
  readWAttr(element, localName) ??
  element.getAttribute(`w14:${localName}`) ??
  element.getAttribute(`w15:${localName}`) ??
  element.getAttribute(localName) ??
  undefined;

const readReviewMetadata = (element: slimdom.Element): DocxReviewMetadata => {
  const metadata: DocxReviewMetadata = {};
  const author = readWAttr(element, "author");
  const date = readWAttr(element, "date");
  const initials = readWAttr(element, "initials");

  if (author) {
    metadata.author = author;
  }
  if (date) {
    metadata.date = date;
  }
  if (initials) {
    metadata.initials = initials;
  }

  return metadata;
};

const commentToReviewMetadata = (comment: DocxComment) => {
  const metadata: Parameters<typeof renderDocxCommentMarkup>[0]["metadata"] = {
    author: comment.author,
  };

  if (comment.date) {
    metadata.date = comment.date;
  }
  if (comment.initials) {
    metadata.initials = comment.initials;
  }
  if (comment.status) {
    metadata.status = comment.status;
  }
  if (comment.thread) {
    metadata.thread = comment.thread;
  }

  return metadata;
};

const readCommentId = (element: slimdom.Element): string | undefined =>
  readWAttr(element, "id");

const renderCommentAnchor = (
  element: slimdom.Element,
  comments: ReadonlyMap<string, DocxComment>,
): string | undefined => {
  const commentId = readCommentId(element);
  const comment = commentId ? comments.get(commentId) : undefined;
  if (!comment) {
    return undefined;
  }

  return renderDocxCommentMarkup({
    metadata: commentToReviewMetadata(comment),
    text: comment.text,
  });
};

const collectRangedCommentIds = (part: slimdom.Document): Set<string> => {
  const ids = new Set<string>();

  for (const element of elementsByLocalName(part, "commentRangeStart")) {
    const id = readCommentId(element);
    if (id) {
      ids.add(id);
    }
  }

  return ids;
};

type AppendCommentAnchorOptions = {
  comments: ReadonlyMap<string, DocxComment>;
  element: slimdom.Element;
  parts: string[];
  rangedCommentIds: ReadonlySet<string>;
};

const appendCommentAnchor = ({
  comments,
  element,
  parts,
  rangedCommentIds,
}: AppendCommentAnchorOptions): boolean => {
  if (element.localName === "commentRangeStart") {
    const commentMarkup = renderCommentAnchor(element, comments);
    if (commentMarkup) {
      parts.push(commentMarkup);
    }
    return true;
  }

  if (element.localName !== "commentReference") {
    return false;
  }

  const commentId = readCommentId(element);
  if (commentId && rangedCommentIds.has(commentId)) {
    return true;
  }

  const commentMarkup = renderCommentAnchor(element, comments);
  if (commentMarkup) {
    parts.push(commentMarkup);
  }
  return true;
};

type AppendWordTextOptions = {
  element: slimdom.Element;
  includeDeletedText: boolean;
  parts: string[];
};

const appendWordText = ({
  element,
  includeDeletedText,
  parts,
}: AppendWordTextOptions): boolean => {
  if (element.localName === "t") {
    parts.push(element.textContent ?? "");
    return true;
  }

  if (includeDeletedText && element.localName === "delText") {
    parts.push(element.textContent ?? "");
    return true;
  }

  if (element.localName === "tab") {
    parts.push("\t");
    return true;
  }

  if (element.localName === "br") {
    parts.push("\n");
    return true;
  }

  return false;
};

const collectPlainText = (element: slimdom.Element): string => {
  const parts: string[] = [];

  const walk = (node: slimdom.Node) => {
    if (!(node instanceof slimdom.Element)) {
      return;
    }
    if (isSkippableSubtree(node)) {
      return;
    }

    if (
      node.namespaceURI === W_NS &&
      appendWordText({
        element: node,
        includeDeletedText: true,
        parts,
      })
    ) {
      return;
    }

    for (const child of node.childNodes) {
      walk(child);
    }
  };

  walk(element);
  return parts.join("");
};

const collectTrackedChangeText = ({
  comments,
  element,
  rangedCommentIds,
}: {
  comments: ReadonlyMap<string, DocxComment>;
  element: slimdom.Element;
  rangedCommentIds: ReadonlySet<string>;
}): string => {
  const parts: string[] = [];

  const walk = (node: slimdom.Node) => {
    if (!(node instanceof slimdom.Element)) {
      return;
    }
    if (isSkippableSubtree(node)) {
      return;
    }

    if (
      node.namespaceURI === W_NS &&
      (appendCommentAnchor({
        comments,
        element: node,
        parts,
        rangedCommentIds,
      }) ||
        appendWordText({
          element: node,
          includeDeletedText: true,
          parts,
        }))
    ) {
      return;
    }

    for (const child of node.childNodes) {
      walk(child);
    }
  };

  walk(element);
  return parts.join("");
};

const collectText = (
  paragraph: slimdom.Element,
  comments: ReadonlyMap<string, DocxComment>,
  rangedCommentIds: ReadonlySet<string>,
): string => {
  const parts: string[] = [];

  const walk = (node: slimdom.Node) => {
    if (!(node instanceof slimdom.Element)) {
      return;
    }
    if (isSkippableSubtree(node)) {
      return;
    }

    if (node.namespaceURI === W_NS) {
      if (node.localName === "ins" || node.localName === "moveTo") {
        const text = collectTrackedChangeText({
          comments,
          element: node,
          rangedCommentIds,
        });
        if (text) {
          parts.push(
            renderDocxInsertionMarkup({
              metadata: readReviewMetadata(node),
              text,
            }),
          );
        }
        return;
      }
      if (node.localName === "del" || node.localName === "moveFrom") {
        const text = collectTrackedChangeText({
          comments,
          element: node,
          rangedCommentIds,
        });
        if (text) {
          parts.push(
            renderDocxDeletionMarkup({
              metadata: readReviewMetadata(node),
              text,
            }),
          );
        }
        return;
      }
      if (
        appendCommentAnchor({
          comments,
          element: node,
          parts,
          rangedCommentIds,
        }) ||
        appendWordText({
          element: node,
          includeDeletedText: false,
          parts,
        })
      ) {
        return;
      }
    }

    for (const child of node.childNodes) {
      walk(child);
    }
  };

  walk(paragraph);
  return parts.join("");
};

const readCommentExtendedMetadata = async (
  zip: JSZip,
): Promise<Map<string, CommentExtendedMetadata>> => {
  const metadata = new Map<string, CommentExtendedMetadata>();
  const commentsExEntry = zip.file("word/commentsExtended.xml");
  if (!commentsExEntry) {
    return metadata;
  }

  let document: slimdom.Document;
  try {
    const xml = await commentsExEntry.async("text");
    document = slimdom.parseXmlDocument(xml);
  } catch {
    return metadata;
  }

  for (const commentEx of document
    .getElementsByTagNameNS("*", "commentEx")
    .filter((node): node is slimdom.Element => node.nodeType === 1)) {
    const paraId = readWordAttr(commentEx, "paraId");
    if (!paraId) {
      continue;
    }

    metadata.set(paraId, {
      status: readWordAttr(commentEx, "done") === "1" ? "resolved" : "open",
      thread: readWordAttr(commentEx, "paraIdParent") ? "reply" : "root",
    });
  }

  return metadata;
};

const readComments = async (zip: JSZip): Promise<Map<string, DocxComment>> => {
  const comments = new Map<string, DocxComment>();
  const commentsEntry = zip.file("word/comments.xml");
  if (!commentsEntry) {
    return comments;
  }

  let document: slimdom.Document;
  try {
    const xml = await commentsEntry.async("text");
    document = slimdom.parseXmlDocument(xml);
  } catch {
    return comments;
  }

  const extendedMetadata = await readCommentExtendedMetadata(zip);

  for (const comment of elementsByLocalName(document, "comment")) {
    const id = readWAttr(comment, "id");
    if (!id) {
      continue;
    }

    const text = collectPlainText(comment).replace(/\s+/g, " ").trim();
    if (text.length === 0) {
      continue;
    }

    const firstParagraph = comment.getElementsByTagNameNS(W_NS, "p").at(0);
    const paraId = firstParagraph
      ? readWordAttr(firstParagraph, "paraId")
      : undefined;
    const commentMetadata = paraId ? extendedMetadata.get(paraId) : undefined;

    const docxComment: DocxComment = {
      author: readWAttr(comment, "author") ?? "Unknown",
      text,
    };
    const date = readWAttr(comment, "date");
    const initials = readWAttr(comment, "initials");
    if (date) {
      docxComment.date = date;
    }
    if (initials) {
      docxComment.initials = initials;
    }
    if (commentMetadata?.status) {
      docxComment.status = commentMetadata.status;
    }
    if (commentMetadata?.thread) {
      docxComment.thread = commentMetadata.thread;
    }

    comments.set(id, docxComment);
  }

  return comments;
};

const getStyleId = (paragraph: slimdom.Element): string | undefined => {
  const pPr = paragraph.getElementsByTagNameNS(W_NS, "pPr").at(0);
  if (!pPr) {
    return undefined;
  }
  const pStyle = pPr.getElementsByTagNameNS(W_NS, "pStyle").at(0);
  return pStyle?.getAttributeNS(W_NS, "val") ?? undefined;
};

const getNumberingMarker = (paragraph: slimdom.Element): string | undefined => {
  const pPr = paragraph.getElementsByTagNameNS(W_NS, "pPr").at(0);
  if (!pPr) {
    return undefined;
  }
  const numPr = pPr.getElementsByTagNameNS(W_NS, "numPr").at(0);
  if (!numPr) {
    return undefined;
  }
  const ilvl = numPr
    .getElementsByTagNameNS(W_NS, "ilvl")
    .at(0)
    ?.getAttributeNS(W_NS, "val");
  // Without resolving the numbering definitions we only know that
  // this paragraph IS a list item, not which marker it would render
  // as. Use the level as a stand-in label so the AI can group items;
  // the editor-side snapshot has the resolved marker, but Phase 1
  // doesn't need pixel parity here.
  return ilvl ? `list-l${ilvl}` : "list";
};

const getOutlineLevel = (paragraph: slimdom.Element): number | undefined => {
  const pPr = paragraph.getElementsByTagNameNS(W_NS, "pPr").at(0);
  if (!pPr) {
    return undefined;
  }
  const outlineLvl = pPr
    .getElementsByTagNameNS(W_NS, "outlineLvl")
    .at(0)
    ?.getAttributeNS(W_NS, "val");
  if (!outlineLvl) {
    return undefined;
  }
  const parsed = Number(outlineLvl);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const detectKind = (
  paragraph: slimdom.Element,
): { kind: FolioAIBlock["kind"]; displayLabel?: string } => {
  const numberingMarker = getNumberingMarker(paragraph);
  if (numberingMarker) {
    return { kind: "listItem", displayLabel: numberingMarker };
  }

  const styleId = getStyleId(paragraph);
  if (styleId && /^heading/i.test(styleId)) {
    return { kind: "heading", displayLabel: styleId };
  }

  const outlineLevel = getOutlineLevel(paragraph);
  if (outlineLevel !== undefined && outlineLevel >= 0) {
    return { kind: "heading" };
  }

  return { kind: "paragraph" };
};

type ExtractBlocksResult = {
  blocks: FolioAIBlock[];
  nextBlockIndex: number;
};

const extractBlocksFromXmlDocument = (
  document: slimdom.Document,
  comments: ReadonlyMap<string, DocxComment>,
  startBlockIndex: number,
): ExtractBlocksResult => {
  const paragraphs = elementsByLocalName(document, "p");
  const rangedCommentIds =
    comments.size === 0 ? EMPTY_COMMENT_IDS : collectRangedCommentIds(document);
  const blocks: FolioAIBlock[] = [];
  let blockIndex = startBlockIndex;

  for (const paragraph of paragraphs) {
    const text = collectText(paragraph, comments, rangedCommentIds)
      .replace(/\s+/g, " ")
      .trim();
    if (text.length === 0) {
      continue;
    }

    const { kind, displayLabel } = detectKind(paragraph);
    const id = `b-${String(++blockIndex).padStart(4, "0")}`;
    blocks.push({
      id,
      kind,
      text,
      ...(displayLabel ? { displayLabel } : {}),
    });
  }

  return { blocks, nextBlockIndex: blockIndex };
};

const extractBlocksFromZipEntry = async ({
  comments,
  path,
  startBlockIndex,
  zip,
}: {
  comments: ReadonlyMap<string, DocxComment>;
  path: string;
  startBlockIndex: number;
  zip: JSZip;
}): Promise<ExtractBlocksResult> => {
  const entry = zip.file(path);
  if (!entry) {
    return { blocks: [], nextBlockIndex: startBlockIndex };
  }

  const xml = await entry.async("text");
  const document = slimdom.parseXmlDocument(xml);
  return extractBlocksFromXmlDocument(document, comments, startBlockIndex);
};

const sortedDocxPartPaths = (zip: JSZip, pattern: RegExp): string[] =>
  Object.keys(zip.files)
    .filter((path) => pattern.test(path))
    .toSorted();

export const extractFolioBlocksFromDocxBuffer = async (
  buffer: ArrayBuffer | Uint8Array,
): Promise<FolioAIBlock[]> => {
  const zip = await JSZip.loadAsync(buffer);
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) {
    return [];
  }

  const xml = await documentEntry.async("text");
  const document = slimdom.parseXmlDocument(xml);
  const comments = await readComments(zip);

  return extractBlocksFromXmlDocument(document, comments, 0).blocks;
};

export const extractFolioBlockTextFromDocxBuffer = async (
  buffer: ArrayBuffer | Uint8Array,
): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) {
    return "";
  }

  const comments = await readComments(zip);
  const blocks: FolioAIBlock[] = [];
  let blockIndex = 0;

  for (const path of sortedDocxPartPaths(zip, DOCX_HEADER_RE)) {
    const result = await extractBlocksFromZipEntry({
      comments,
      path,
      startBlockIndex: blockIndex,
      zip,
    });
    blocks.push(...result.blocks);
    blockIndex = result.nextBlockIndex;
  }

  const bodyXml = await documentEntry.async("text");
  const bodyDocument = slimdom.parseXmlDocument(bodyXml);
  const bodyResult = extractBlocksFromXmlDocument(
    bodyDocument,
    comments,
    blockIndex,
  );
  blocks.push(...bodyResult.blocks);
  blockIndex = bodyResult.nextBlockIndex;

  for (const path of sortedDocxPartPaths(zip, DOCX_FOOTER_RE)) {
    const result = await extractBlocksFromZipEntry({
      comments,
      path,
      startBlockIndex: blockIndex,
      zip,
    });
    blocks.push(...result.blocks);
    blockIndex = result.nextBlockIndex;
  }

  return blocks.map((block) => block.text).join("\n");
};
