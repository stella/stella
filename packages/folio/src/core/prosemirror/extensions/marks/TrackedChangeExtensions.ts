/**
 * Tracked Change Mark Extensions — insertion and deletion marks
 *
 * Renders insertions with colored underline and deletions with colored
 * strikethrough, matching the standard MS Word display for tracked changes.
 * Colors are assigned per author via CSS custom properties (see editor.css).
 */

import { getAuthorColorIdx, AUTHOR_COLORS } from "../../../utils/authorColors";
import { createMarkExtension } from "../create";

/**
 * Build an inline style string for the tracked change author color.
 * ProseMirror toDOM runs before the layout painter, so we set the
 * decoration here for correct rendering in both the layout-painter
 * path and the ProseMirror DOM path.
 */
const insertionStyle = (color: string): string =>
  `color: ${color}; text-decoration: underline; text-decoration-color: ${color};`;

const deletionStyle = (color: string): string =>
  `color: ${color}; text-decoration: line-through; text-decoration-color: ${color};`;

/**
 * Insertion mark — text added in tracked changes
 * Renders with per-author colored underline.
 */
export const InsertionExtension = createMarkExtension({
  name: "insertion",
  schemaMarkName: "insertion",
  markSpec: {
    attrs: {
      revisionId: { default: 0 },
      author: { default: "" },
      date: { default: null },
      // `"moveTo"` distinguishes inserted text that originated as a
      // `w:moveTo` (the destination half of an OOXML move) from a
      // plain `w:ins`. Carried through PM so `fromProseDoc` can
      // re-emit the correct OOXML element without relying on
      // brittle revisionId pairing across the doc.
      moveKind: { default: null },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "span.docx-insertion",
        getAttrs(dom) {
          return {
            revisionId: Number.parseInt(dom.dataset["revisionId"] ?? "0", 10),
            author: dom.dataset["author"] ?? "",
            date: dom.dataset["date"] ?? null,
          };
        },
      },
    ],
    toDOM(mark) {
      // SAFETY: TrackedChange attrs always match this shape per schema
      const revisionId = Number(mark.attrs["revisionId"]);
      const author = String(mark.attrs["author"]);
      // SAFETY: date is null or a date string per schema default
      const date =
        mark.attrs["date"] !== null ? String(mark.attrs["date"]) : null;
      const idx = getAuthorColorIdx(author);
      // SAFETY: getAuthorColorIdx returns modulo AUTHOR_COLORS.length
      const color = AUTHOR_COLORS[idx] ?? "#000000";
      const datePart = date !== null ? new Date(date).toLocaleDateString() : "";
      const titleParts = [author, datePart].filter(Boolean);
      return [
        "span",
        {
          class: "docx-insertion",
          "data-revision-id": String(revisionId),
          "data-author": author,
          "data-tc-author-idx": String(idx),
          ...(date !== null ? { "data-date": date } : {}),
          ...(titleParts.length > 0
            ? { title: `Inserted: ${titleParts.join(", ")}` }
            : {}),
          style: insertionStyle(color),
        },
        0,
      ];
    },
  },
});

/**
 * Deletion mark — text removed in tracked changes
 * Renders with per-author colored strikethrough.
 */
export const DeletionExtension = createMarkExtension({
  name: "deletion",
  schemaMarkName: "deletion",
  markSpec: {
    attrs: {
      revisionId: { default: 0 },
      author: { default: "" },
      date: { default: null },
      // `"moveFrom"` distinguishes deleted text that originated as a
      // `w:moveFrom` (the source half of an OOXML move) from a plain
      // `w:del`. Carried through PM so `fromProseDoc` can re-emit
      // the correct OOXML element without relying on brittle
      // revisionId pairing across the doc.
      moveKind: { default: null },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "span.docx-deletion",
        getAttrs(dom) {
          return {
            revisionId: Number.parseInt(dom.dataset["revisionId"] ?? "0", 10),
            author: dom.dataset["author"] ?? "",
            date: dom.dataset["date"] ?? null,
          };
        },
      },
    ],
    toDOM(mark) {
      // SAFETY: TrackedChange attrs always match this shape per schema
      const revisionId = Number(mark.attrs["revisionId"]);
      const author = String(mark.attrs["author"]);
      // SAFETY: date is null or a date string per schema default
      const date =
        mark.attrs["date"] !== null ? String(mark.attrs["date"]) : null;
      const idx = getAuthorColorIdx(author);
      // SAFETY: getAuthorColorIdx returns modulo AUTHOR_COLORS.length
      const color = AUTHOR_COLORS[idx] ?? "#000000";
      const datePart = date !== null ? new Date(date).toLocaleDateString() : "";
      const titleParts = [author, datePart].filter(Boolean);
      return [
        "span",
        {
          class: "docx-deletion",
          "data-revision-id": String(revisionId),
          "data-author": author,
          "data-tc-author-idx": String(idx),
          ...(date !== null ? { "data-date": date } : {}),
          ...(titleParts.length > 0
            ? { title: `Deleted: ${titleParts.join(", ")}` }
            : {}),
          style: deletionStyle(color),
        },
        0,
      ];
    },
  },
});
