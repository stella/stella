/**
 * Hidden Text Mark Extension (w:vanish, OOXML §17.3.2.41)
 *
 * Word's editing view dims hidden text with a dotted underline so the
 * author can navigate to and edit it; the print/normal view suppresses it
 * entirely. The painter mirrors the editing-view treatment so PM cursor
 * traversal stays correct across hidden ranges. The `docx-hidden` class
 * hook lets host CSS opt into print-style suppression independently.
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
      return [
        "span",
        {
          class: "docx-hidden",
          style: "opacity: 0.4; text-decoration: underline dotted",
        },
        0,
      ];
    },
  },
});
