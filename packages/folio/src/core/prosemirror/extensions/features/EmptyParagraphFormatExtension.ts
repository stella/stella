/**
 * EmptyParagraphFormat — re-establishes stored marks for an empty styled
 * paragraph so typed text inherits the style's run formatting (bold, color,
 * size, font).
 *
 * Why this exists:
 * An empty paragraph carries its run defaults in the `defaultTextFormatting`
 * attr (set at load by `toProseDoc`, and when a style is applied via
 * `applyStyle`). The visible painter only derives font/size from that attr,
 * so an empty heading renders a correctly sized caret — but typed text only
 * becomes bold/colored if it carries real marks. Those marks live in
 * `storedMarks`, which ProseMirror clears on the next selection change
 * (e.g. when the style picker dropdown returns focus to the editor).
 *
 * This plugin watches for the caret sitting in an empty paragraph with no
 * stored marks and re-derives them from `defaultTextFormatting`, but only
 * when the defaults carry formatting the painter can't reproduce on its own
 * (bold/italic/color/…). Plain body paragraphs (font + size only) are left
 * untouched so ordinary typed text stays mark-free and serializes cleanly.
 */

import type { Schema } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";

import type { TextFormatting } from "../../../types/document";
import { createExtension } from "../create";
import { textFormattingToMarks } from "../marks/markUtils";
import type { ExtensionContext, ExtensionRuntime } from "../types";

export const emptyParagraphFormatKey = new PluginKey("emptyParagraphFormat");

/**
 * Run-formatting properties the painter does NOT reproduce from
 * `defaultTextFormatting` on its own (it forwards only font family + size).
 * When an empty paragraph's defaults carry any of these, typed text must
 * acquire real marks or it would render unstyled. Kept in sync with the
 * properties `textFormattingToMarks` can turn into marks — listing one it
 * can't (e.g. allCaps) would gate work that produces nothing.
 */
function hasNonFontDefaults(dtf: TextFormatting): boolean {
  return !!(
    dtf.bold ||
    dtf.italic ||
    dtf.underline ||
    dtf.strike ||
    dtf.doubleStrike ||
    dtf.color ||
    dtf.highlight ||
    dtf.vertAlign
  );
}

function createEmptyParagraphFormatPlugin(schema: Schema): Plugin {
  return new Plugin({
    key: emptyParagraphFormatKey,
    appendTransaction(transactions, _oldState, newState) {
      // Only react when the caret may have moved into an empty paragraph.
      if (!transactions.some((t) => t.selectionSet || t.docChanged)) {
        return null;
      }

      const { selection } = newState;
      if (!selection.empty) {
        return null;
      }

      // A format command (bold button, applyStyle, clearFormatting) already
      // set stored marks — never override an explicit choice.
      if (newState.storedMarks !== null) {
        return null;
      }

      const para = selection.$from.parent;
      if (para.type.name !== "paragraph" || para.content.size !== 0) {
        return null;
      }

      const dtf = para.attrs["defaultTextFormatting"] as
        | TextFormatting
        | null
        | undefined;
      if (!dtf || !hasNonFontDefaults(dtf)) {
        return null;
      }

      const marks = textFormattingToMarks(dtf, schema);
      if (marks.length === 0) {
        return null;
      }

      const tr = newState.tr.setStoredMarks(marks);
      tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}

export const EmptyParagraphFormatExtension = createExtension({
  name: "emptyParagraphFormat",
  onSchemaReady(ctx: ExtensionContext): ExtensionRuntime {
    return {
      plugins: [createEmptyParagraphFormatPlugin(ctx.schema)],
    };
  },
});
