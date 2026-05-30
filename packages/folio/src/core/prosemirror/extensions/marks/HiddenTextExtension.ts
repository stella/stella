/**
 * Hidden Text Mark Extension (w:vanish, OOXML §17.3.2.41)
 *
 * Word's editing view dims hidden text with a dotted underline so the
 * author can navigate to and edit it; the print/normal view suppresses it
 * entirely. The painter mirrors the editing-view treatment so PM cursor
 * traversal stays correct across hidden ranges. The `docx-hidden` class
 * hook lets host CSS opt into print-style suppression independently.
 *
 * The dotted-underline visual is delivered via `editor.css` (`.docx-hidden`
 * rule), NOT inline `text-decoration`. Inline `text-decoration: underline`
 * would be picked up by `UnderlineExtension`'s `style: "text-decoration"`
 * parser on DOM/clipboard reparse and add a spurious `<w:u>` alongside
 * `<w:vanish/>` on export.
 *
 * eigenpal #424 (w:vanish gap 9).
 */

import { createMarkExtension } from "../create";

export const HiddenTextExtension = createMarkExtension({
  name: "hidden",
  schemaMarkName: "hidden",
  markSpec: {
    parseDOM: [{ tag: "span.docx-hidden" }],
    toDOM() {
      return ["span", { class: "docx-hidden" }, 0];
    },
  },
});
