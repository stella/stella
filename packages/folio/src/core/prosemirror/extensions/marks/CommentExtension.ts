/**
 * Comment Mark Extension — highlights text that has comments
 *
 * Applied to text ranges between commentRangeStart and commentRangeEnd.
 * The comment ID links to the Comment object in the document model.
 */

import { createMarkExtension } from "../create";

export const CommentExtension = createMarkExtension({
  name: "comment",
  schemaMarkName: "comment",
  markSpec: {
    attrs: {
      /** Comment ID (matches Comment.id) */
      commentId: { default: 0 },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "span.docx-comment",
        getAttrs(dom) {
          return {
            commentId: Number.parseInt(dom.dataset["commentId"] ?? "0", 10),
          };
        },
      },
    ],
    toDOM(mark) {
      return [
        "span",
        {
          class: "docx-comment",
          "data-comment-id": String(mark.attrs["commentId"]),
          style:
            "background-color: var(--doc-comment-bg, rgba(255, 212, 0, 0.08)); border-bottom: 1px solid var(--doc-comment-border, rgba(180, 130, 0, 0.24));",
        },
        0,
      ];
    },
  },
});
