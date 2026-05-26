/**
 * Hard Break Extension — Shift+Enter line break
 */

import { panic } from "better-result";

import { createNodeExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";

export const HardBreakExtension = createNodeExtension({
  name: "hardBreak",
  schemaNodeName: "hardBreak",
  nodeSpec: {
    inline: true,
    group: "inline",
    attrs: {
      breakType: { default: null },
    },
    selectable: false,
    parseDOM: [
      {
        tag: "br",
        getAttrs(node) {
          if (!(node instanceof HTMLElement)) {
            return null;
          }
          const breakType = node.dataset["docxBreakType"];
          return breakType === "column" ? { breakType } : null;
        },
      },
    ],
    toDOM(node) {
      if (node.attrs["breakType"] === "column") {
        return ["br", { "data-docx-break-type": "column" }];
      }
      return ["br"];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const hardBreakType = ctx.schema.nodes["hardBreak"];
    if (!hardBreakType) {
      panic("Missing node type: hardBreak");
    }

    return {
      keyboardShortcuts: {
        "Shift-Enter": (state, dispatch) => {
          if (dispatch) {
            dispatch(
              state.tr
                .replaceSelectionWith(hardBreakType.create())
                .scrollIntoView(),
            );
          }
          return true;
        },
      },
    };
  },
});
