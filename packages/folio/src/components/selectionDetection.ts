import { NodeSelection } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";

import {
  findChangeAtPosition,
  findParagraphBoundaryChangeAtPosition,
} from "../core/prosemirror/commands/comments";
import type {
  ActiveTrackedChangeInfo,
  ImageContextInfo,
} from "./DocxEditor.props";

/**
 * If the editor's current selection is a `NodeSelection` of an `image`
 * node, return the toolbar/image-dialog context derived from its attrs;
 * otherwise return `null`. Pure — no state mutation, no DOM access.
 */
export function detectImageContext(
  state: EditorState,
): ImageContextInfo | null {
  const sel = state.selection;
  // `instanceof NodeSelection` is the idiomatic ProseMirror narrowing —
  // it gives us a typed `.node` without an unsafe `as` cast and rejects
  // custom selection subclasses that happen to expose a `node` field.
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image") {
    return null;
  }
  const selectedNode = sel.node;

  const attrs = selectedNode.attrs;
  const readRequiredStringAttr = (key: string, fallback: string) => {
    const value = attrs[key];
    return typeof value === "string" ? value : fallback;
  };
  const readNullableStringAttr = (key: string) => {
    const value = attrs[key];
    return typeof value === "string" ? value : null;
  };
  const borderWidth = attrs["borderWidth"];

  return {
    pos: sel.from,
    wrapType: readRequiredStringAttr("wrapType", "inline"),
    displayMode: readRequiredStringAttr("displayMode", "inline"),
    cssFloat: readNullableStringAttr("cssFloat"),
    transform: readNullableStringAttr("transform"),
    alt: readNullableStringAttr("alt"),
    borderWidth: typeof borderWidth === "number" ? borderWidth : null,
    borderColor: readNullableStringAttr("borderColor"),
    borderStyle: readNullableStringAttr("borderStyle"),
  };
}

/**
 * If the cursor sits on a text node carrying an `insertion` or `deletion`
 * mark, or inside a paragraph with a property-only tracked list change,
 * return the active tracked-change context for the contextual review
 * toolbar. Pure — no state mutation, no DOM access.
 *
 * The returned `from`/`to` cover the full extent of the change (expanded
 * via `findChangeAtPosition`), not just the cursor's node.
 */
export function detectActiveTrackedChange(
  state: EditorState,
): ActiveTrackedChangeInfo | null {
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const node = $pos.parent;
  if (!node.isTextblock) {
    return null;
  }

  let childOffset = 0;
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    const childStart = $pos.start() + childOffset;
    const childEnd = childStart + child.nodeSize;
    if (from < childStart || from > childEnd || !child.isText) {
      childOffset += child.nodeSize;
      continue;
    }
    for (const mark of child.marks) {
      if (mark.type.name !== "insertion" && mark.type.name !== "deletion") {
        continue;
      }
      const range = findChangeAtPosition(state, from, from);
      return {
        type: mark.type.name === "insertion" ? "insertion" : "deletion",
        author: (mark.attrs["author"] as string) || "Unknown",
        date: (mark.attrs["date"] as string) || null,
        from: range.from,
        to: range.to,
      };
    }
    childOffset += child.nodeSize;
  }

  const paragraphChange = findParagraphBoundaryChangeAtPosition(state, from);
  if (!paragraphChange) {
    return null;
  }
  return {
    type: paragraphChange.type,
    author: paragraphChange.author || "Unknown",
    date: paragraphChange.date || null,
    from: paragraphChange.from,
    to: paragraphChange.to,
  };
}
