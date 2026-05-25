/**
 * Italic Mark Extension
 */

import { panic } from "better-result";
import { toggleMark } from "prosemirror-commands";

import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

export const ItalicExtension = createMarkExtension({
  name: "italic",
  schemaMarkName: "italic",
  markSpec: {
    parseDOM: [
      { tag: "i" },
      { tag: "em" },
      {
        style: "font-style",
        getAttrs: (value) => (value === "italic" ? null : false),
      },
    ],
    toDOM() {
      return ["em", 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const italicType = ctx.schema.marks["italic"];
    if (!italicType) {
      panic("Missing mark type: italic");
    }
    return {
      commands: {
        toggleItalic: () => toggleMark(italicType),
      },
      keyboardShortcuts: {
        "Mod-i": toggleMark(italicType),
      },
    };
  },
});
