/**
 * Checking the citations the writer types, without being asked.
 *
 * The signal is the editor's own selection callback, which fires on every
 * selection-bearing transaction: typing, clicking, arrow keys. Nothing polls
 * and nothing reads the document per keystroke — the callback only records
 * where the caret is and restarts a timer. When the writing there stops, the
 * paragraph under the caret is read once and, if it names a decision, the
 * sentence around it is checked.
 */

import { useRef } from "react";
import type { RefObject } from "react";

import { useDebouncedCallback } from "use-debounce";

import type { DocxEditorRef } from "@/components/docx/app-docx-editor";
import { detached } from "@/lib/detached";

/**
 * How long the paragraph has to stand still before it is checked. Long enough
 * that a sentence being typed is not sent word by word, short enough that the
 * answer arrives while the writer is still on the citation.
 */
const SETTLE_MS = 1500;

/**
 * The paragraph a document position sits in. Null when the editor has no live
 * view or the position falls between anchors, which costs the check a run and
 * nothing else.
 */
export const blockContaining = (
  editor: DocxEditorRef | null,
  position: number,
): { id: string; text: string } | null => {
  const snapshot = editor?.createAIEditSnapshot() ?? null;
  if (snapshot === null) {
    return null;
  }
  const anchor = Object.values(snapshot.anchors).find(
    (candidate) => candidate.from <= position && position <= candidate.to,
  );
  return anchor === undefined ? null : { id: anchor.id, text: anchor.text };
};

type AutomaticCitationCheckOptions = {
  editorRef: RefObject<DocxEditorRef | null>;
  checkParagraph: (request: {
    paragraphText: string;
    blockId: string | null;
  }) => Promise<void>;
};

/**
 * Returns what the editor calls on every selection change. Reading the whole
 * document to find the caret's paragraph is the one expensive step, so it
 * happens after the timer, not in the callback.
 */
export const useAutomaticCitationCheck = ({
  checkParagraph,
  editorRef,
}: AutomaticCitationCheckOptions): ((position: number) => void) => {
  const caretRef = useRef<number | null>(null);
  const checkSettledParagraph = useDebouncedCallback(() => {
    const caret = caretRef.current;
    if (caret === null) {
      return;
    }
    const block = blockContaining(editorRef.current, caret);
    if (block === null) {
      return;
    }
    detached(
      checkParagraph({ paragraphText: block.text, blockId: block.id }),
      "docx.citation-check-automatic",
    );
  }, SETTLE_MS);

  return (position) => {
    caretRef.current = position;
    checkSettledParagraph();
  };
};
