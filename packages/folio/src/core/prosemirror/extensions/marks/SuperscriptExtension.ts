/**
 * Superscript Mark Extension
 */

import { toggleMark } from "prosemirror-commands";

import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

export const SuperscriptExtension = createMarkExtension({
  name: "superscript",
  schemaMarkName: "superscript",
  markSpec: {
    excludes: "subscript",
    parseDOM: [{ tag: "sup" }],
    toDOM() {
      return ["sup", 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const superscriptType = ctx.schema.marks["superscript"];
    if (!superscriptType) {
      throw new Error("Missing mark type: superscript");
    }
    return {
      commands: {
        toggleSuperscript: () => toggleMark(superscriptType),
      },
    };
  },
});
