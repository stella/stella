/**
 * Block-content fill variant of the editor-ref `setContentControlContent`
 * transaction.
 *
 * Sits in a separate module from `contentControls.ts` so the import graph
 * stays acyclic: this file pulls in the toProseDoc conversion pipeline,
 * which transitively reaches the PM schema and StarterKit. The widgets
 * plugin in turn imports the basic `contentControls` helpers but not this
 * file, breaking what would otherwise be a tight cycle.
 */

import type { Node as PMNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";

import type { ContentControlFilter } from "../../content-controls";
import type { BlockContent } from "../../types/document";
import { headerFooterToProseDoc } from "../conversion/toProseDoc";
import { replaceBlockSdtChildrenForFill } from "./contentControls";

function blockContentToPMChildren(blocks: BlockContent[]): PMNode[] {
  // `headerFooterToProseDoc` runs the same per-block converters the body
  // uses and emits a doc whose children match what `blockSdt`'s
  // `content: block+` accepts.
  const pmDoc = headerFooterToProseDoc(blocks);
  const out: PMNode[] = [];
  for (let i = 0; i < pmDoc.childCount; i += 1) {
    out.push(pmDoc.child(i));
  }
  return out;
}

/**
 * Replace the children of the content control matching `filter` with the
 * PM-converted form of `blocks`. Locked controls throw
 * `ContentControlLockedError` unless `{ force: true }` is passed.
 */
export function setContentControlContentBlocksTr(
  state: EditorState,
  filter: ContentControlFilter,
  blocks: BlockContent[],
  options: { force?: boolean } = {},
): Transaction | null {
  const children = blockContentToPMChildren(blocks);
  return replaceBlockSdtChildrenForFill(state, filter, children, options);
}
