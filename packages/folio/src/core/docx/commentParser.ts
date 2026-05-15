/**
 * Comment Parser - Parse comments.xml, commentsExtensible.xml, and
 * commentsExtended.xml.
 *
 * - `comments.xml` (w) carries the comment author, local date, and body.
 * - `commentsExtensible.xml` (w16cex, Word 2016+) carries reliable UTC
 *   timestamps via `w16cex:dateUtc` — Word's `w:date` is local time
 *   without an offset and so is ambiguous.
 * - `commentsExtended.xml` (w15, Word 2013+) carries reply-thread
 *   parent links via `w15:paraIdParent` and the resolved/done state
 *   via `w15:done`. Cross-referenced via the `w14:paraId` on
 *   `w:comment` and the matching `w15:paraId` on `w15:commentEx`.
 *
 * OOXML Reference:
 * - Comments: w:comments
 * - Comment: w:comment (w:id, w:author, w:date, w:initials, w14:paraId)
 * - Comment content: child w:p elements
 */

import type {
  Comment,
  Paragraph,
  Theme,
  RelationshipMap,
  MediaFile,
} from "../types/document";
import { parseParagraph } from "./paragraphParser";
import type { StyleMap } from "./styleParser";
import {
  parseXml,
  findChild,
  getChildElements,
  getAttribute,
} from "./xmlParser";

/**
 * Build a lookup from paraId → dateUtc from commentsExtensible.xml
 *
 * The XML structure is:
 * <w16cex:commentsExtensible>
 *   <w16cex:comment w16cex:paraId="..." w16cex:dateUtc="2024-02-10T14:30:45Z"/>
 * </w16cex:commentsExtensible>
 */
function parseCommentsExtensible(xml: string): Map<string, string> {
  const dateUtcByParaId = new Map<string, string>();

  const root = parseXml(xml);

  // Find the root element (may be w16cex:commentsExtensible or similar)
  const container = findChild(root, "w16cex", "commentsExtensible") ?? root;
  for (const child of getChildElements(container)) {
    const localName = child.name?.replace(/^.*:/, "") ?? "";
    if (localName !== "comment") {
      continue;
    }

    // Try multiple namespace prefixes since they vary between Word versions
    const paraId =
      getAttribute(child, "w16cex", "paraId") ??
      getAttribute(child, "w15", "paraId") ??
      child.attributes?.["w16cex:paraId"] ??
      child.attributes?.["w15:paraId"];

    const dateUtc =
      getAttribute(child, "w16cex", "dateUtc") ??
      getAttribute(child, "w15", "dateUtc") ??
      child.attributes?.["w16cex:dateUtc"] ??
      child.attributes?.["w15:dateUtc"];

    if (paraId && dateUtc) {
      dateUtcByParaId.set(String(paraId).toUpperCase(), String(dateUtc));
    }
  }

  return dateUtcByParaId;
}

type CommentExtendedInfo = {
  parentParaId?: string;
  done?: boolean;
};

/**
 * Build a lookup from paraId → reply-thread info from
 * commentsExtended.xml. The XML structure is:
 *
 * ```xml
 * <w15:commentsEx>
 *   <w15:commentEx w15:paraId="..." w15:done="0"/>
 *   <w15:commentEx w15:paraId="..." w15:paraIdParent="..." w15:done="1"/>
 * </w15:commentsEx>
 * ```
 *
 * `w15:paraIdParent` points at the parent thread's paraId; `w15:done`
 * (`"1"` / `"true"`) marks the thread resolved.
 */
function parseCommentsExtended(xml: string): Map<string, CommentExtendedInfo> {
  const infoByParaId = new Map<string, CommentExtendedInfo>();

  const root = parseXml(xml);
  const container = findChild(root, "w15", "commentsEx") ?? root;
  for (const child of getChildElements(container)) {
    const localName = child.name?.replace(/^.*:/, "") ?? "";
    if (localName !== "commentEx") {
      continue;
    }

    const paraId =
      getAttribute(child, "w15", "paraId") ?? child.attributes?.["w15:paraId"];
    if (!paraId) {
      continue;
    }

    const parentParaId =
      getAttribute(child, "w15", "paraIdParent") ??
      child.attributes?.["w15:paraIdParent"];
    const doneAttr =
      getAttribute(child, "w15", "done") ?? child.attributes?.["w15:done"];

    const info: CommentExtendedInfo = {};
    if (parentParaId) {
      info.parentParaId = String(parentParaId).toUpperCase();
    }
    if (doneAttr !== undefined) {
      const v = String(doneAttr).toLowerCase();
      info.done = v === "1" || v === "true";
    }
    infoByParaId.set(String(paraId).toUpperCase(), info);
  }

  return infoByParaId;
}

/**
 * Parse comments.xml into an array of Comment objects.
 *
 * If `commentsExtensibleXml` is provided, UTC timestamps are
 * cross-referenced via paraId and preferred over the ambiguous w:date
 * local time. If `commentsExtendedXml` is provided, reply-thread
 * parent links (`parentId`) and resolved state (`done`) are populated.
 */
export function parseComments(
  commentsXml: string | null,
  styles: StyleMap | null,
  theme: Theme | null,
  rels: RelationshipMap,
  media: Map<string, MediaFile>,
  commentsExtensibleXml?: string | null,
  commentsExtendedXml?: string | null,
): Comment[] {
  if (!commentsXml) {
    return [];
  }

  const root = parseXml(commentsXml);

  // Build UTC date lookup from commentsExtensible (Word 2016+).
  const dateUtcByParaId = commentsExtensibleXml
    ? parseCommentsExtensible(commentsExtensibleXml)
    : new Map<string, string>();

  // Build reply-thread + done lookup from commentsExtended (Word 2013+).
  const extendedByParaId = commentsExtendedXml
    ? parseCommentsExtended(commentsExtendedXml)
    : new Map<string, CommentExtendedInfo>();

  const commentsEl = findChild(root, "w", "comments") ?? root;
  const children = getChildElements(commentsEl);
  const comments: Comment[] = [];
  // Track the paraId → comment-id mapping so we can resolve
  // `w15:paraIdParent` (which references the parent comment's paraId,
  // not its `w:id`) to a numeric `parentId` once every comment is parsed.
  const commentIdByParaId = new Map<string, number>();
  const paraIdByCommentIndex = new Map<number, string>();

  for (const child of children) {
    const localName = child.name?.replace(/^.*:/, "") ?? "";
    if (localName !== "comment") {
      continue;
    }

    const id = Number.parseInt(getAttribute(child, "w", "id") ?? "0", 10);
    const author = getAttribute(child, "w", "author") ?? "Unknown";
    const rawInitials = getAttribute(child, "w", "initials");
    const initials = rawInitials !== null ? String(rawInitials) : undefined;
    const rawDate = getAttribute(child, "w", "date");
    const localDate = rawDate !== null ? String(rawDate) : undefined;

    // The paraId on `w:comment` is the join key used by both
    // commentsExtensible (UTC dates) and commentsExtended (reply links).
    const rawParaId =
      getAttribute(child, "w14", "paraId") ??
      child.attributes?.["w14:paraId"] ??
      getAttribute(child, "w", "paraId");
    const paraId = rawParaId ? String(rawParaId).toUpperCase() : null;

    const dateUtc = paraId ? dateUtcByParaId.get(paraId) : undefined;
    // Prefer UTC date over ambiguous local date
    const date = dateUtc ?? localDate;

    const extendedInfo = paraId ? extendedByParaId.get(paraId) : undefined;
    const done = extendedInfo?.done;

    // Parse comment content (paragraphs)
    const paragraphs: Paragraph[] = [];
    for (const contentChild of getChildElements(child)) {
      const contentName = contentChild.name?.replace(/^.*:/, "") ?? "";
      if (contentName === "p") {
        const paragraph = parseParagraph(
          contentChild,
          styles,
          theme,
          null,
          rels,
          media,
        );
        paragraphs.push(paragraph);
      }
    }

    const commentIndex = comments.length;
    if (paraId) {
      commentIdByParaId.set(paraId, id);
      paraIdByCommentIndex.set(commentIndex, paraId);
    }

    comments.push({
      id,
      author,
      ...(initials !== undefined ? { initials } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(done !== undefined ? { done } : {}),
      content: paragraphs,
    });
  }

  // Second pass: resolve `w15:paraIdParent` → numeric parent comment id.
  // A reply whose parent paraId is unknown (e.g. the parent was deleted
  // from comments.xml but a stale `w15:commentEx` remains) is left as a
  // top-level comment so it isn't silently dropped.
  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    if (!comment) {
      continue;
    }
    const paraId = paraIdByCommentIndex.get(i);
    if (!paraId) {
      continue;
    }
    const parentParaId = extendedByParaId.get(paraId)?.parentParaId;
    if (!parentParaId) {
      continue;
    }
    const parentId = commentIdByParaId.get(parentParaId);
    if (parentId !== undefined && parentId !== comment.id) {
      comments[i] = { ...comment, parentId };
    }
  }

  return comments;
}
