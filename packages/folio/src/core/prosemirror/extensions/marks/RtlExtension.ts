// eigenpal #424 (gap 10) — per-run right-to-left direction (w:rtl).
//
// The mark sets `dir="rtl"` on the run span so the browser's bidi algorithm
// reorders just that run, independent of the paragraph's direction. The
// physical writing system stays the document default; only the run's run
// direction flips, matching Word's behaviour for mixed-direction lines.

import { createMarkExtension } from "../create";

export const RtlExtension = createMarkExtension({
  name: "rtl",
  schemaMarkName: "rtl",
  markSpec: {
    parseDOM: [
      {
        tag: "span[dir=rtl]",
        // HTML's `dir` attribute is case-insensitive; ProseMirror may also hand
        // us a tag-string in some pipelines, so guard before reading attrs.
        getAttrs: (dom) =>
          typeof dom !== "string" &&
          dom.getAttribute("dir")?.toLowerCase() === "rtl"
            ? {}
            : false,
      },
    ],
    toDOM() {
      return ["span", { dir: "rtl" }, 0];
    },
  },
});
