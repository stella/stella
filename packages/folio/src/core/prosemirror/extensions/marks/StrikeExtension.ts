/**
 * Strikethrough Mark Extension
 */

import { panic } from "better-result";
import { toggleMark } from "prosemirror-commands";

import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

export const StrikeExtension = createMarkExtension({
  name: "strike",
  schemaMarkName: "strike",
  markSpec: {
    attrs: {
      double: { default: false },
    },
    parseDOM: [
      { tag: "s" },
      { tag: "strike" },
      { tag: "del" },
      {
        style: "text-decoration",
        getAttrs: (value) => (value.includes("line-through") ? {} : false),
      },
    ],
    toDOM() {
      return ["s", 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const strikeType = ctx.schema.marks["strike"];
    if (!strikeType) {
      panic("Missing mark type: strike");
    }
    return {
      commands: {
        toggleStrike: () => toggleMark(strikeType),
      },
    };
  },
});
