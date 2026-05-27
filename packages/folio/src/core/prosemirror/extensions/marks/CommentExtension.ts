/**
 * Comment Mark Extension — highlights text that has comments
 *
 * Applied to text ranges between commentRangeStart and commentRangeEnd.
 * The comment ID links to the Comment object in the document model.
 */

import { expectCommentMarkAttrs } from "../../attrs";
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
      const { commentId } = expectCommentMarkAttrs(mark);
      return [
        "span",
        {
          class: "docx-comment",
          "data-comment-id": String(commentId),
        },
        0,
      ];
    },
  },
});
