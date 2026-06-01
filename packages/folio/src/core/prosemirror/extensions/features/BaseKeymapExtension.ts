/**
 * Base Keymap Extension — wraps prosemirror-commands baseKeymap
 *
 * Priority: Low (150) — must be the last keymap so other extensions can override keys
 */

import {
  baseKeymap,
  splitBlock,
  deleteSelection,
  joinBackward,
  joinForward,
  selectAll,
  selectParentNode,
} from "prosemirror-commands";
import type { Mark, Node as PMNode } from "prosemirror-model";
import type { Command, Transaction } from "prosemirror-state";

import type { TextFormatting } from "../../../types/document";
import { mergeFontFamily } from "../../../utils/fontFamilyMerge";
import { getDocumentStyleResolver } from "../../plugins/documentStyles";
import { paragraphAttrsFromResolvedStyle } from "../../styles/resolvedStyleAttrs";
import type { StyleResolver } from "../../styles/styleResolver";
import { createExtension } from "../create";
import { textFormattingToMarks } from "../marks/markUtils";
import { Priority } from "../types";
import type { ExtensionRuntime, ExtensionContext } from "../types";

function chainCommands(...commands: Command[]): Command {
  return (state, dispatch, view) => {
    for (const cmd of commands) {
      if (cmd(state, dispatch, view)) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Backspace at the start of a paragraph clears first-line indent / hanging indent
 * before joining with the previous paragraph (matches Word behavior).
 */
const clearIndentOnBackspace: Command = (state, dispatch) => {
  const { $cursor } = state.selection as {
    $cursor?: {
      parentOffset: number;
      parent: { type: { name: string }; attrs: Record<string, unknown> };
      pos: number;
      before: () => number;
    };
  };
  if (!$cursor) {
    return false;
  }

  // Only at the very start of a paragraph
  if ($cursor.parentOffset !== 0) {
    return false;
  }
  if ($cursor.parent.type.name !== "paragraph") {
    return false;
  }

  const attrs = $cursor.parent.attrs;
  const hasFirstLine =
    attrs["indentFirstLine"] !== null &&
    (attrs["indentFirstLine"] as number) > 0;
  const hasHanging = !!attrs["hangingIndent"];
  const hasIndentLeft =
    attrs["indentLeft"] !== null && (attrs["indentLeft"] as number) > 0;

  if (!hasFirstLine && !hasHanging && !hasIndentLeft) {
    return false;
  }

  if (dispatch) {
    const pos = $cursor.before();
    const tr = state.tr.setNodeMarkup(pos, undefined, {
      ...attrs,
      indentFirstLine: null,
      hangingIndent: null,
      indentLeft: null,
    });
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Custom Enter handler: splits the block, inherits style-related attrs,
 * clears paragraph borders, and preserves font marks on the new paragraph.
 *
 * splitBlock creates a new paragraph with default attrs (all null),
 * so we must manually copy style-related attrs from the source paragraph.
 * Word does NOT propagate paragraph borders (w:pBdr) on Enter.
 */
const INHERITED_PARA_ATTRS = [
  "defaultTextFormatting",
  "styleId",
  "lineSpacing",
  "lineSpacingRule",
  "spaceAfter",
  "spaceBefore",
  "contextualSpacing",
] as const;

/** Mark types that represent style-inherited formatting (font, size, color). */
const STYLE_MARK_NAMES = new Set(["fontFamily", "fontSize", "textColor"]);

/**
 * If `sourcePara`'s style defines a `w:next`, replace the empty `newPara`
 * with that style's resolved attrs and seed stored marks from its run
 * formatting. Returns true when a switch happened (caller should dispatch
 * the transaction as-is), false when the source style has no `w:next` and
 * the caller should fall back to the regular inheritance path.
 */
function applyNextParagraphStyle(
  tr: Transaction,
  sourcePara: PMNode,
  newPara: PMNode,
  resolver: StyleResolver,
): boolean {
  const nextStyleId = resolver.getNextStyleId(
    sourcePara.attrs["styleId"] as string | null | undefined,
  );
  if (!nextStyleId) {
    return false;
  }

  const resolved = resolver.resolveParagraphStyle(nextStyleId);
  const { $from } = tr.selection;
  tr.setNodeMarkup($from.before(), undefined, {
    ...newPara.attrs,
    styleId: nextStyleId,
    ...paragraphAttrsFromResolvedStyle(resolved),
    borders: null,
  });

  // setStoredMarks MUST come after setNodeMarkup — every step clears it.
  tr.setStoredMarks(
    resolved.runFormatting
      ? textFormattingToMarks(resolved.runFormatting, tr.doc.type.schema)
      : [],
  );
  return true;
}

export const splitBlockClearBorders: Command = (state, dispatch, view) => {
  // Capture source paragraph info BEFORE split (splitBlock resets everything)
  const { $from: preSplitFrom } = state.selection;
  const sourcePara =
    preSplitFrom.parent.type.name === "paragraph" ? preSplitFrom.parent : null;

  // Collect style marks from the cursor position before splitting.
  // Use storedMarks if set, otherwise resolve from the position.
  const preMarks = state.storedMarks || preSplitFrom.marks();
  const styleMarks = preMarks.filter((m) => STYLE_MARK_NAMES.has(m.type.name));

  // Intercept splitBlock's transaction so we can modify it before dispatch.
  // This ensures attrs + stored marks are set in a single transaction,
  // avoiding a flash where the empty paragraph has no formatting.
  const splitResult = { tr: null as Transaction | null };
  const capturingDispatch = dispatch
    ? (tr: Transaction) => {
        splitResult.tr = tr;
      }
    : undefined;

  if (!splitBlock(state, capturingDispatch, view)) {
    return false;
  }

  if (dispatch && splitResult.tr !== null) {
    // After split, cursor is in the new (second) paragraph.
    // Apply attr inheritance, border clearing, and stored marks to the SAME transaction.
    const tr = splitResult.tr;
    const { $from } = tr.selection;
    const newPara = $from.parent;

    if (newPara.type.name === "paragraph") {
      // Word's `w:next`: pressing Enter at the end of a paragraph (the new
      // paragraph is empty) switches it to the style's follow-on style — e.g.
      // a heading drops to body text. Only applies to an empty trailing
      // paragraph; splitting mid-paragraph keeps the style on both halves.
      const resolver = getDocumentStyleResolver(state);
      if (
        resolver !== null &&
        sourcePara !== null &&
        newPara.textContent.length === 0 &&
        applyNextParagraphStyle(tr, sourcePara, newPara, resolver)
      ) {
        dispatch(tr.scrollIntoView());
        return true;
      }

      const newAttrs = { ...newPara.attrs };
      let attrsChanged = false;

      // Copy inherited attrs from source paragraph
      if (sourcePara) {
        for (const key of INHERITED_PARA_ATTRS) {
          const srcVal = sourcePara.attrs[key];
          if (srcVal !== null && newAttrs[key] === null) {
            newAttrs[key] = srcVal;
            attrsChanged = true;
          }
        }
      }

      // Clear borders (Word does not propagate paragraph borders on Enter)
      if (newAttrs["borders"]) {
        newAttrs["borders"] = null;
        attrsChanged = true;
      }

      if (attrsChanged) {
        tr.setNodeMarkup($from.before(), undefined, newAttrs);
      }

      // For empty paragraphs (Enter at end of line), set stored marks so typed text
      // inherits font family, font size, and text color. We skip bold/italic/etc —
      // Word doesn't carry direct formatting to new paragraphs.
      if (newPara.textContent.length === 0) {
        // Determine effective style marks. When text has explicit marks (e.g. user
        // applied a font override), use those. When text inherits formatting from
        // the paragraph style chain (no explicit marks), derive marks from the
        // source paragraph's defaultTextFormatting.
        let effectiveMarks: Mark[] = styleMarks;

        if (effectiveMarks.length === 0 && sourcePara) {
          const dtf = sourcePara.attrs["defaultTextFormatting"] as
            | TextFormatting
            | undefined;
          if (dtf) {
            const allMarks = textFormattingToMarks(dtf, state.schema);
            effectiveMarks = allMarks.filter((m) =>
              STYLE_MARK_NAMES.has(m.type.name),
            );
          }
        }

        if (effectiveMarks.length > 0) {
          // Sync defaultTextFormatting with the actual cursor marks so the empty
          // paragraph measurement (used for caret height) matches the stored marks.
          const dtf = { ...newAttrs["defaultTextFormatting"] };
          let dtfChanged = false;
          for (const m of effectiveMarks) {
            if (
              m.type.name === "fontSize" &&
              m.attrs["size"] !== dtf.fontSize
            ) {
              dtf.fontSize = m.attrs["size"];
              dtfChanged = true;
            }
            if (m.type.name === "fontFamily") {
              const ascii = m.attrs["ascii"] as string | undefined;
              if (
                ascii &&
                (!dtf.fontFamily || dtf.fontFamily.ascii !== ascii)
              ) {
                const nextFontFamily: NonNullable<
                  TextFormatting["fontFamily"]
                > = { ascii };
                const hAnsi = m.attrs["hAnsi"] as string | undefined;
                if (hAnsi !== undefined) {
                  nextFontFamily.hAnsi = hAnsi;
                }
                dtf.fontFamily = mergeFontFamily(
                  dtf.fontFamily,
                  nextFontFamily,
                );
                dtfChanged = true;
              }
            }
          }
          if (dtfChanged) {
            tr.setNodeMarkup($from.before(), undefined, {
              ...newAttrs,
              defaultTextFormatting: dtf,
            });
          }

          // IMPORTANT: setStoredMarks MUST be called AFTER all setNodeMarkup calls.
          // setNodeMarkup adds a ReplaceStep which clears storedMarks on the transaction.
          tr.setStoredMarks(effectiveMarks);
        }
      }
    }

    dispatch(tr.scrollIntoView());
  }

  return true;
};

export const BaseKeymapExtension = createExtension({
  name: "baseKeymap",
  priority: Priority.Low,
  onSchemaReady(_ctx: ExtensionContext): ExtensionRuntime {
    return {
      keyboardShortcuts: {
        // Base keymap provides default editing commands
        ...baseKeymap,
        // Override some keys with better defaults
        Enter: splitBlockClearBorders,
        Backspace: chainCommands(
          deleteSelection,
          clearIndentOnBackspace,
          joinBackward,
        ),
        Delete: chainCommands(deleteSelection, joinForward),
        "Mod-a": selectAll,
        Escape: selectParentNode,
      },
    };
  },
});
