/**
 * Hyperlink Mark Extension
 */

import { panic } from "better-result";
import type { Command, EditorState } from "prosemirror-state";

import { createMarkExtension } from "../create";
import type { ExtensionContext, ExtensionRuntime } from "../types";
import { isMarkActive } from "./markUtils";

// ============================================================================
// HYPERLINK QUERY HELPERS (exported for toolbar)
// ============================================================================

export function isHyperlinkActive(state: EditorState): boolean {
  const hlType = state.schema.marks["hyperlink"];
  if (!hlType) {
    return false;
  }
  return isMarkActive(state, hlType);
}

export function getHyperlinkAttrs(
  state: EditorState,
): { href: string; tooltip?: string } | null {
  const hlType = state.schema.marks["hyperlink"];
  if (!hlType) {
    return null;
  }

  const { empty, $from, from, to } = state.selection;

  if (empty) {
    const marks = state.storedMarks ?? $from.marks();
    for (const mark of marks) {
      if (mark.type === hlType) {
        // SAFETY: HyperlinkAttrs always has href/tooltip per schema
        const href = String(mark.attrs["href"]);
        const tooltip =
          mark.attrs["tooltip"] !== null
            ? String(mark.attrs["tooltip"])
            : undefined;
        return { href, ...(tooltip !== undefined ? { tooltip } : {}) };
      }
    }
    return null;
  }

  let attrs: { href: string; tooltip?: string } | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isText && attrs === null) {
      const mark = hlType.isInSet(node.marks);
      if (mark) {
        // SAFETY: HyperlinkAttrs always has href/tooltip per schema
        const href = String(mark.attrs["href"]);
        const tooltip =
          mark.attrs["tooltip"] !== null
            ? String(mark.attrs["tooltip"])
            : undefined;
        attrs = { href, ...(tooltip !== undefined ? { tooltip } : {}) };
        return false;
      }
    }
    return true;
  });

  return attrs;
}

export function getSelectedText(state: EditorState): string {
  const { from, to, empty } = state.selection;
  if (empty) {
    return "";
  }
  return state.doc.textBetween(from, to, "");
}

// ============================================================================
// EXTENSION
// ============================================================================

export const HyperlinkExtension = createMarkExtension({
  name: "hyperlink",
  schemaMarkName: "hyperlink",
  markSpec: {
    attrs: {
      href: {},
      tooltip: { default: null },
      rId: { default: null },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => ({
          // HTMLElement.getAttribute is available on all element types
          href: dom.getAttribute("href") ?? "",
          tooltip: dom.getAttribute("title") ?? undefined,
        }),
      },
    ],
    toDOM(mark) {
      // SAFETY: HyperlinkAttrs always has href/tooltip per schema
      const href = String(mark.attrs["href"]);
      const tooltip =
        mark.attrs["tooltip"] !== null ? String(mark.attrs["tooltip"]) : null;
      const domAttrs: Record<string, string> = {
        href,
        target: "_blank",
        rel: "noopener noreferrer",
      };
      if (tooltip) {
        domAttrs["title"] = tooltip;
      }
      return ["a", domAttrs, 0];
    },
  },
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    const hlType = ctx.schema.marks["hyperlink"];
    if (!hlType) {
      panic("Missing mark type: hyperlink");
    }

    const setHyperlink =
      (href: string, tooltip?: string): Command =>
      (state, dispatch) => {
        const { from, to, empty } = state.selection;

        if (empty) {
          return false;
        }

        if (dispatch) {
          const mark = hlType.create({ href, tooltip: tooltip || null });
          let tr = state.tr.addMark(from, to, mark);
          // Remove any explicit text color so the default hyperlink blue (#0563c1)
          // shows through, matching MS Word behavior
          const textColorType = state.schema.marks["textColor"];
          if (textColorType) {
            tr = tr.removeMark(from, to, textColorType);
          }
          dispatch(tr.scrollIntoView());
        }

        return true;
      };

    const removeHyperlink: Command = (state, dispatch) => {
      const { from, to, empty } = state.selection;

      if (empty) {
        const $pos = state.selection.$from;
        const marks = $pos.marks();
        const linkMark = marks.find((m) => m.type === hlType);

        if (!linkMark) {
          return false;
        }

        let start = $pos.pos;
        let end = $pos.pos;

        const parent = $pos.parent;
        // oxlint-disable-next-line unicorn/no-array-for-each -- ProseMirror Node.forEach
        parent.forEach((node, offset) => {
          if (node.isText) {
            const nodeStart = $pos.start() + offset;
            const nodeEnd = nodeStart + node.nodeSize;

            if (nodeStart <= $pos.pos && $pos.pos <= nodeEnd) {
              const hasLink = node.marks.some((m) => m.type === hlType);
              if (hasLink) {
                start = Math.min(start, nodeStart);
                end = Math.max(end, nodeEnd);
              }
            }
          }
        });

        if (dispatch) {
          dispatch(state.tr.removeMark(start, end, hlType).scrollIntoView());
        }
        return true;
      }

      if (dispatch) {
        dispatch(state.tr.removeMark(from, to, hlType).scrollIntoView());
      }

      return true;
    };

    const insertHyperlink =
      (text: string, href: string, tooltip?: string): Command =>
      (state, dispatch) => {
        if (dispatch) {
          const mark = hlType.create({ href, tooltip: tooltip || null });
          const textNode = state.schema.text(text, [mark]);
          dispatch(
            state.tr.replaceSelectionWith(textNode, false).scrollIntoView(),
          );
        }
        return true;
      };

    return {
      commands: {
        setHyperlink,
        removeHyperlink: () => removeHyperlink,
        insertHyperlink,
      },
    };
  },
});
