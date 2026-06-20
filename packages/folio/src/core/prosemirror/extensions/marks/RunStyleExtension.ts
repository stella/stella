// eigenpal/docx-editor#833 — run character-style reference (`w:rStyle`).
//
// The parser reads `<w:rStyle>` into `run.formatting.styleId` and the serializer
// re-emits it, but PM conversion bakes the style's formatting into direct marks
// (via `resolveTextFormatting`) and otherwise drops the named reference. This
// inert mark carries the styleId (e.g. `Strong`, `Emphasis`, a code style)
// through the round-trip so `<w:rStyle>` survives an edit. It has no visual
// effect of its own — the style's formatting already rides on direct marks — so
// there is no `toDOM` styling; only the `data-run-style` round-trips for paste.

import { expectRunStyleMarkAttrs } from "../../attrs";
import { createMarkExtension } from "../create";

export const RunStyleExtension = createMarkExtension({
  name: "runStyle",
  schemaMarkName: "runStyle",
  markSpec: {
    attrs: {
      // Required (no default): the mark is meaningless without a styleId, and
      // `RunStyleAttrs`/`readRunStyleMarkAttrs` both treat it as a required
      // string. parseDOM returns false when the marker is absent, and the mark
      // is only ever created with a styleId.
      styleId: {},
    },
    parseDOM: [
      {
        tag: "span[data-run-style]",
        getAttrs: (dom) => {
          const styleId = (dom as HTMLElement).dataset["runStyle"];
          // Only adopt spans that explicitly carry the marker; others are not
          // run-style references.
          return styleId ? { styleId } : false;
        },
      },
    ],
    toDOM(mark) {
      const { styleId } = expectRunStyleMarkAttrs(mark);
      return [
        "span",
        { class: "docx-run-style", "data-run-style": styleId },
        0,
      ];
    },
  },
});
