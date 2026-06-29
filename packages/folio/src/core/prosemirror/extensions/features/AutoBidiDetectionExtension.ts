/**
 * AutoBidiDetection — sets the paragraph `bidi` attribute on RTL-led
 * paragraphs that arrived without an explicit direction decision.
 *
 * Why: Folio only ever rendered/exported RTL when a paragraph already carried
 * `w:bidi` (from a Word import) or the user toggled it by hand. Content that
 * never had a flag — AI-generated text, Markdown/HTML/plain-text imports, paste,
 * or just typing Arabic without the shortcut — stayed left-to-right both in the
 * editor and in the exported `.docx`. The ProseMirror doc is the single source
 * of truth for both the layout painter (`toFlowBlocks`) and the serializer
 * (`fromProseDoc`), so writing the attribute here fixes the editor and the Word
 * export from one place.
 *
 * Detection uses the first-strong-character rule (`detectBaseDirection`), the
 * same logic the layout painter uses for base direction.
 *
 * Clobber safety: we act ONLY when `bidi` is unset (`null`/`undefined`).
 * Explicit user/import decisions are `bidi: true` (RTL) or `bidi: false`
 * (LTR — see `setLtr`), so an Arabic paragraph the user deliberately set to LTR
 * is never re-flipped. We never set `bidi: false` here; LTR-led paragraphs are
 * left untouched (unset already means LTR).
 *
 * Mirrors the appendTransaction + ensure-in-state pattern of
 * `ParaIdAllocatorExtension`.
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";

import { detectBaseDirection } from "../../../utils/baseDirection";
import { createExtension } from "../create";
import type { ExtensionRuntime } from "../types";
import { ignoreTrackedChanges } from "./ParagraphChangeTrackerExtension";

export const autoBidiDetectionKey = new PluginKey("autoBidiDetection");

type BidiUpdate = {
  pos: number;
  attrs: Record<string, unknown>;
};

const collectBidiUpdates = (doc: PMNode): BidiUpdate[] => {
  const updates: BidiUpdate[] = [];

  doc.descendants((node, pos) => {
    // Non-paragraph: recurse — paragraphs nested in tables / cells are in scope.
    if (node.type.name !== "paragraph") {
      return;
    }

    // Only undecided paragraphs are candidates. An explicit true/false (user
    // toggle or Word import) is authoritative and must not be overridden.
    if (node.attrs["bidi"] != null) {
      return false;
    }

    if (detectBaseDirection(node.textContent) === "rtl") {
      updates.push({ pos, attrs: { ...node.attrs, bidi: true } });
    }

    // Paragraphs only contain inline content — skip the subtree.
    return false;
  });

  return updates;
};

const applyBidiUpdates = (
  state: EditorState,
  updates: BidiUpdate[],
): EditorState["tr"] => {
  const tr = state.tr;
  for (const update of updates) {
    tr.setNodeMarkup(update.pos, undefined, update.attrs);
  }
  ignoreTrackedChanges(tr);
  tr.setMeta(autoBidiDetectionKey, "applied");
  tr.setMeta("addToHistory", false);
  return tr;
};

/**
 * Imperatively apply auto-bidi detection to a freshly built state (initial
 * load: Markdown import, DOCX import, template). `appendTransaction` does not
 * fire for the initial document, so seeded content needs this pass.
 */
export const ensureBaseDirectionInState = (state: EditorState): EditorState => {
  const updates = collectBidiUpdates(state.doc);
  if (updates.length === 0) {
    return state;
  }
  return state.apply(applyBidiUpdates(state, updates));
};

const createAutoBidiDetectionPlugin = (): Plugin =>
  new Plugin({
    key: autoBidiDetectionKey,
    appendTransaction(transactions, _oldState, newState) {
      // Selection-only / mark-only transactions can't have changed paragraph text.
      if (!transactions.some((t) => t.docChanged)) {
        return null;
      }

      const updates = collectBidiUpdates(newState.doc);
      if (updates.length === 0) {
        return null;
      }

      return applyBidiUpdates(newState, updates);
    },
  });

export const AutoBidiDetectionExtension = createExtension({
  name: "autoBidiDetection",
  defaultOptions: {},
  onSchemaReady(): ExtensionRuntime {
    return {
      plugins: [createAutoBidiDetectionPlugin()],
    };
  },
});
