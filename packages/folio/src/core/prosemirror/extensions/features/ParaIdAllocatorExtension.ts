/**
 * ParaIdAllocator — assigns a stable `w14:paraId` to every paragraph.
 *
 * Lifted from
 * https://github.com/eigenpal/docx-editor/blob/main/packages/core/src/prosemirror/extensions/features/ParaIdAllocatorExtension.ts
 * (Apache-2.0). Adapted to folio's `createExtension` + import style;
 * keep behaviour in sync upstream.
 *
 * Why: AI tooling, chat citation chips, and the change tracker all
 * anchor on `paraId`. A paragraph with `paraId: null` is invisible
 * to those surfaces; a duplicated paraId (the second half of an
 * Enter-split, or content pasted from another doc) silently desyncs
 * their anchors. This plugin closes both gaps by allocating fresh
 * ids in an `appendTransaction` hook after every doc-changed step.
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";

import { generateHexId } from "../../../utils/hexId";
import { createExtension } from "../create";
import type { ExtensionRuntime } from "../types";
import { ignoreTrackedChanges } from "./ParagraphChangeTrackerExtension";

export const paraIdAllocatorKey = new PluginKey("paraIdAllocator");

type ParaIdUpdate = {
  pos: number;
  attrs: Record<string, unknown>;
};

const collectParaIdUpdates = (doc: PMNode): ParaIdUpdate[] => {
  const seen = new Set<string>();
  const updates: ParaIdUpdate[] = [];

  doc.descendants((node, pos) => {
    // Non-paragraph: recurse — paragraphs nested in tables / cells
    // are still in scope.
    if (node.type.name !== "paragraph") {
      return;
    }

    const id = node.attrs["paraId"];
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      let newId = generateHexId();
      while (seen.has(newId)) {
        newId = generateHexId();
      }
      seen.add(newId);
      updates.push({ pos, attrs: { ...node.attrs, paraId: newId } });
    } else {
      seen.add(id);
    }

    // Paragraphs only contain inline content (text / runs) — nothing
    // we'd ever paraId. Skip the subtree.
    return false;
  });

  return updates;
};

export const ensureParaIdsInState = (state: EditorState): EditorState => {
  const updates = collectParaIdUpdates(state.doc);
  if (updates.length === 0) {
    return state;
  }

  const tr = state.tr;
  for (const update of updates) {
    tr.setNodeMarkup(update.pos, undefined, update.attrs);
  }
  ignoreTrackedChanges(tr);
  tr.setMeta(paraIdAllocatorKey, "allocated");
  tr.setMeta("addToHistory", false);
  return state.apply(tr);
};

const createParaIdAllocatorPlugin = (): Plugin =>
  new Plugin({
    key: paraIdAllocatorKey,
    appendTransaction(transactions, _oldState, newState) {
      // Skip selection-only / mark-only transactions — they can't have
      // created or duplicated a paragraph.
      if (!transactions.some((t) => t.docChanged)) {
        return null;
      }

      const updates = collectParaIdUpdates(newState.doc);
      if (updates.length === 0) {
        return null;
      }

      const tr = newState.tr;
      for (const u of updates) {
        tr.setNodeMarkup(u.pos, undefined, u.attrs);
      }
      tr.setMeta(paraIdAllocatorKey, "allocated");
      tr.setMeta("addToHistory", false);
      return tr;
    },
  });

export const ParaIdAllocatorExtension = createExtension({
  name: "paraIdAllocator",
  defaultOptions: {},
  onSchemaReady(): ExtensionRuntime {
    return {
      plugins: [createParaIdAllocatorPlugin()],
    };
  },
});
