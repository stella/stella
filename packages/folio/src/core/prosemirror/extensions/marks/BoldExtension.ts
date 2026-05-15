/**
 * Bold Mark Extension
 */

import { toggleMark } from "prosemirror-commands";

import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

export const BoldExtension = createMarkExtension({
  name: "bold",
  schemaMarkName: "bold",
  markSpec: {
    parseDOM: [
      { tag: "strong" },
      {
        tag: "b",
        getAttrs(dom) {
          // Reject <b> with explicit non-bold font-weight (e.g. Google Docs structural wrapper)
          const fw = dom.style.fontWeight;
          if (fw === "normal" || fw === "400") {
            return false;
          }
          return null;
        },
      },
      {
        style: "font-weight",
        getAttrs: (value) =>
          /^(bold(er)?|[5-9]\d{2})$/.test(value) ? null : false,
      },
    ],
    toDOM() {
      return ["strong", 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const boldType = ctx.schema.marks["bold"];
    if (!boldType) {
      throw new Error("Missing mark type: bold");
    }
    return {
      commands: {
        toggleBold: () => toggleMark(boldType),
      },
      keyboardShortcuts: {
        "Mod-b": toggleMark(boldType),
      },
    };
  },
});
