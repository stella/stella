/**
 * Subscript Mark Extension
 */

import { toggleMark } from "prosemirror-commands";

import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

export const SubscriptExtension = createMarkExtension({
  name: "subscript",
  schemaMarkName: "subscript",
  markSpec: {
    excludes: "superscript",
    parseDOM: [{ tag: "sub" }],
    toDOM() {
      return ["sub", 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const subscriptType = ctx.schema.marks["subscript"];
    if (!subscriptType) {
      throw new Error("Missing mark type: subscript");
    }
    return {
      commands: {
        toggleSubscript: () => toggleMark(subscriptType),
      },
    };
  },
});
