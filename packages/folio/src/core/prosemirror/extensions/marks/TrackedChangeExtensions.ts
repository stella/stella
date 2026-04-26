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
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "span.docx-insertion",
        getAttrs(dom) {
          const el = dom as HTMLElement;
          return {
            revisionId: Number.parseInt(el.dataset["revisionId"] || "0", 10),
            author: el.dataset["author"] || "",
            date: el.dataset["date"] || null,
          };
        },
      },
    ],
    toDOM(mark) {
      const author = mark.attrs["author"] as string;
      const idx = getAuthorColorIdx(author ?? "");
      // SAFETY: getAuthorColorIdx returns modulo AUTHOR_COLORS.length
      const color = AUTHOR_COLORS[idx]!;
      const datePart = mark.attrs["date"]
        ? new Date(mark.attrs["date"] as string).toLocaleDateString()
        : "";
      const titleParts = [author, datePart].filter(Boolean);
      return [
        "span",
        {
          class: "docx-insertion",
          "data-revision-id": String(mark.attrs["revisionId"]),
          "data-author": author,
          "data-tc-author-idx": String(idx),
          ...(mark.attrs["date"] ? { "data-date": mark.attrs["date"] } : {}),
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
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "span.docx-deletion",
        getAttrs(dom) {
          const el = dom as HTMLElement;
          return {
            revisionId: Number.parseInt(el.dataset["revisionId"] || "0", 10),
            author: el.dataset["author"] || "",
            date: el.dataset["date"] || null,
          };
        },
      },
    ],
    toDOM(mark) {
      const author = mark.attrs["author"] as string;
      const idx = getAuthorColorIdx(author ?? "");
      // SAFETY: getAuthorColorIdx returns modulo AUTHOR_COLORS.length
      const color = AUTHOR_COLORS[idx]!;
      const datePart = mark.attrs["date"]
        ? new Date(mark.attrs["date"] as string).toLocaleDateString()
        : "";
      const titleParts = [author, datePart].filter(Boolean);
      return [
        "span",
        {
          class: "docx-deletion",
          "data-revision-id": String(mark.attrs["revisionId"]),
          "data-author": author,
          "data-tc-author-idx": String(idx),
          ...(mark.attrs["date"] ? { "data-date": mark.attrs["date"] } : {}),
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
