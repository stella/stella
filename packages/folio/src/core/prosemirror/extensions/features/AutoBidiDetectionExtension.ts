/**
 * AutoBidiDetection — sets the paragraph `direction` (to `{ source: "auto" }`)
 * on RTL-led paragraphs that arrived without an explicit direction decision.
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
 * Auto vs. explicit: only "auto-managed" paragraphs are (re-)evaluated — those
 * whose `direction` is undecided (absent) or was set by this detector
 * (`source: "auto"`). A manual user toggle or imported `w:bidi`
 * (`source: "manual"`) is authoritative and never touched. Because the detector
 * re-evaluates its own decisions, replacing an auto-RTL paragraph's text with
 * Latin clears it again (no stale "sticky" RTL).
 *
 * The `direction` discriminated union is editor-runtime state; only its resolved
 * RTL-ness serializes (`w:bidi`) — the persisted model keeps the flat tri-state.
 *
 * Mirrors the appendTransaction + ensure-in-state pattern of
 * `ParaIdAllocatorExtension`.
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";

import type { DirtyRange } from "../../../paged-layout/incrementalMeasure";
import { getTransactionDirtyRange } from "../../../paged-layout/transactionDirtyRange";
import { detectBaseDirection } from "../../../utils/baseDirection";
import { directionIsAutoManaged } from "../../paragraphDirection";
import type { ParagraphDirection } from "../../paragraphDirection";
import { createExtension } from "../create";
import type { ExtensionRuntime } from "../types";
import { ignoreTrackedChanges } from "./ParagraphChangeTrackerExtension";

export const autoBidiDetectionKey = new PluginKey("autoBidiDetection");

type BidiUpdate = {
  pos: number;
  attrs: Record<string, unknown>;
};

// First-strong detection needs the paragraph's directional text in document
// order. `node.textContent` skips inline field atoms (MERGEFIELD/REF results
// keep their rendered text in attrs, not child text), which would mis-detect a
// field-led paragraph. Walk descendants so text nested in inline content
// controls (SDT) and hyperlinks is included, and fold in field display text.
const paragraphDirectionalText = (node: PMNode): string => {
  let text = "";
  node.descendants((child) => {
    if (child.isText) {
      // Deleted and moved-away text both carry the `deletion` mark; it is not
      // live content, so it must not drive base-direction detection.
      const deleted = child.marks.some((mark) => mark.type.name === "deletion");
      if (!deleted) {
        text += child.text ?? "";
      }
    } else if (child.type.name === "field") {
      const display = child.attrs["displayText"];
      if (typeof display === "string") {
        text += display;
      }
    }
  });
  return text;
};

// Decide the update (if any) for a single paragraph node.
const evaluateParagraph = (node: PMNode, pos: number): BidiUpdate | null => {
  const current = node.attrs["direction"];
  // Explicit decision (manual toggle / imported w:bidi): leave it alone.
  if (!directionIsAutoManaged(current)) {
    return null;
  }

  const wantRtl = detectBaseDirection(paragraphDirectionalText(node)) === "rtl";
  // Auto-managed means `current` is undecided (absent) or `{ source: "auto" }`,
  // so its RTL-ness is exactly whether it is already auto. No change when that
  // already matches the detected direction.
  const currentIsAuto = current?.source === "auto";
  if (currentIsAuto === wantRtl) {
    return null;
  }
  const desired: ParagraphDirection | null = wantRtl
    ? { source: "auto" }
    : null;
  return { pos, attrs: { ...node.attrs, direction: desired } };
};

// Whole-document scan (load/seed, and the rare multi-transaction fallback).
const collectBidiUpdates = (doc: PMNode): BidiUpdate[] => {
  const updates: BidiUpdate[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph") {
      // Recurse — paragraphs nested in tables / cells are in scope.
      return;
    }
    const update = evaluateParagraph(node, pos);
    if (update) {
      updates.push(update);
    }
    // Paragraphs only contain inline content — skip the subtree.
    return false;
  });
  return updates;
};

// Scan only the paragraphs overlapping a transaction's edited range, so a
// keystroke in a large mostly-LTR document doesn't re-scan every paragraph.
const collectBidiUpdatesInRange = (
  doc: PMNode,
  range: DirtyRange,
): BidiUpdate[] => {
  const from = Math.max(0, Math.min(range.from, doc.content.size));
  const to = Math.max(from, Math.min(range.to, doc.content.size));
  const seen = new Set<number>();
  const updates: BidiUpdate[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "paragraph" && !seen.has(pos)) {
      seen.add(pos);
      const update = evaluateParagraph(node, pos);
      if (update) {
        updates.push(update);
      }
    }
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
 *
 * Like the paraId allocator this is `ignoreTrackedChanges`, so a normalized
 * paragraph the user never edits is not in `changedParaIds`. Full save (the
 * default; and the only path for Markdown/template/new docs, which have no
 * original buffer) serializes the whole PM doc, so the flag is written. The
 * selective-save path (dark `selectiveSave` flag) intentionally preserves
 * untouched original paragraphs byte-for-byte, so an imported DOCX whose Arabic
 * arrived without `w:bidi` and is saved without any edit keeps the original
 * bytes; editing the paragraph tracks it and the patch then includes `w:bidi`.
 */
export const ensureBaseDirectionInState = (state: EditorState): EditorState => {
  // Respect the extension-disable contract: if a manager was built with
  // `disable: ["autoBidiDetection"]`, the plugin is absent from the state and
  // this imperative seed pass must be a no-op too (otherwise a disabled feature
  // would still materialise — and, on the collaborative path, persist — bidi
  // attrs). The live `appendTransaction` already only runs when registered.
  if (!autoBidiDetectionKey.get(state)) {
    return state;
  }
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

      // Common case: a single transaction — scan only its edited range. For the
      // rarer multi-transaction batch (positions would span intermediate docs),
      // fall back to a correct whole-document scan.
      const [first, ...rest] = transactions;
      const range =
        first && rest.length === 0 ? getTransactionDirtyRange(first) : null;
      const updates = range
        ? collectBidiUpdatesInRange(newState.doc, range)
        : collectBidiUpdates(newState.doc);
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
