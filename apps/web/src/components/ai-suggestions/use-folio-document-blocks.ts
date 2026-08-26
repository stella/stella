/**
 * The reviewed document's block order, read from the live editor.
 *
 * A run's findings cite block ids; nothing in the run says where those blocks
 * sit relative to each other. The editor's own `createAIEditSnapshot()` is the
 * answer: it walks the document in the same order the server-side extractor
 * did when it minted the ids, so a citation indexes straight into `blocks`.
 *
 * Read once, when the editor becomes readable. The snapshot is a picture of
 * the document as it was opened; a reviewer who edits a clause moves the
 * findings' anchors, which the next run — not this read — reconciles.
 */

import { useState } from "react";
import type { RefObject } from "react";

import type { DocxEditorRef, FolioAIBlock } from "@stll/folio-react";

import { useExternalSyncEffect } from "@/hooks/use-effect";

/** Stable empty read: a fresh `[]` per render would re-run every consumer. */
const NO_BLOCKS: readonly FolioAIBlock[] = [];

/**
 * How long to keep asking for a snapshot. The editor defers creating its view
 * until something needs it, and a large DOCX takes a while to parse; past this
 * the document is not coming, and the surfaces that wanted it degrade rather
 * than spin a frame loop forever.
 */
const SNAPSHOT_FRAME_BUDGET = 600;

export const useFolioDocumentBlocks = (
  editorRef: RefObject<DocxEditorRef | null>,
  enabled: boolean,
): readonly FolioAIBlock[] => {
  const [blocks, setBlocks] = useState<readonly FolioAIBlock[]>(NO_BLOCKS);

  useExternalSyncEffect(() => {
    if (!enabled) {
      setBlocks(NO_BLOCKS);
      return undefined;
    }
    let frame: number | null = null;
    let framesLeft = SNAPSHOT_FRAME_BUDGET;
    const read = () => {
      frame = null;
      const editor = editorRef.current;
      const snapshot = (() => {
        if (editor === null) {
          return null;
        }
        // The view is deferred until a surface asks for it; a reader who has
        // not clicked into the document yet would otherwise wait forever.
        editor.ensureEditorView({ focus: false });
        return editor.createAIEditSnapshot();
      })();
      if (snapshot !== null) {
        setBlocks(snapshot.blocks);
        return;
      }
      framesLeft -= 1;
      if (framesLeft > 0) {
        frame = requestAnimationFrame(read);
      }
    };
    read();
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [editorRef, enabled]);

  return blocks;
};
