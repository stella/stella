/**
 * The citation check's working half, loaded only once the feature is on: the
 * reference reader, the automatic check as the caret settles in a paragraph,
 * the context-menu entry on a selection that names a decision, and the card
 * that holds the answers. `use-docx-citation-check` keeps the editor side
 * small and imports this module lazily, so a cold visit never pays for it.
 */

import { useRef, useState } from "react";
import type { RefObject } from "react";

import { useExternalSyncEffect, useLatestCallback } from "@stll/ui/effects";
import { FileSearchIcon } from "@stll/ui/icons";

import type { DocxEditorRef } from "@/components/docx/app-docx-editor";
import { CitationCheckCard } from "@/components/docx/citation-check/citation-check-card";
import { citationCheckCatalog } from "@/components/docx/citation-check/citation-check-catalog";
import { findDecisionReference } from "@/components/docx/citation-check/citation-check.logic";
import {
  blockContaining,
  useAutomaticCitationCheck,
} from "@/components/docx/citation-check/use-automatic-citation-check";
import { useCitationCheck } from "@/components/docx/citation-check/use-citation-check";
import type {
  CitationCheckMenu,
  TextSelection,
} from "@/components/docx/citation-check/use-docx-citation-check";
import { detached } from "@/lib/detached";

const CHECK_CITATION_CONTEXT_ID = "stella.check-citation";

type CitationCheckHostProps = {
  editorRef: RefObject<DocxEditorRef | null>;
  /** Where the editor's selection bridge finds this host's handler. */
  selectionRef: RefObject<((selection: TextSelection) => void) | null>;
  /** The context-menu entry, or null while the selection names no decision. */
  onMenuChange: (menu: CitationCheckMenu | null) => void;
};

const CitationCheckHostContents = ({
  editorRef,
  onMenuChange,
  selectionRef,
}: CitationCheckHostProps) => {
  const t = citationCheckCatalog.useTranslations();
  // The decision reference the current selection names, if any: what decides
  // whether the context menu offers a citation check.
  const [citedReference, setCitedReference] = useState<string | null>(null);
  // Held in a ref, not in state: right-click can collapse the live selection
  // before the context action fires, so the sentence the writer had
  // highlighted is read from here rather than from the view.
  const lastSelectionRef = useRef<TextSelection | null>(null);
  const citationCheck = useCitationCheck();
  // The check also runs unasked, on whatever paragraph the caret settles in,
  // in read-only documents too: reading a colleague's draft is when a
  // citation most wants checking, and the check only reads.
  const handleCaretMoved = useAutomaticCitationCheck({
    editorRef,
    checkParagraph: citationCheck.runSettledParagraph,
  });

  const runSelectedCheck = useLatestCallback(
    (range: { from: number; to: number }) => {
      const selection = lastSelectionRef.current;
      if (citedReference === null || selection === null) {
        return;
      }
      detached(
        citationCheck.runSelected({
          citation: citedReference,
          // The writer's own selection is the sentence being checked; the
          // editor never widens it, so what is judged is what was highlighted.
          claim: selection.text,
          blockId: blockContaining(editorRef.current, range.from)?.id ?? null,
        }),
        "docx.citation-check",
      );
    },
  );

  const handleSelection = useLatestCallback((selection: TextSelection) => {
    lastSelectionRef.current = selection;
    // Only the reference itself reaches state, so the host re-renders when
    // the "Check citation" entry appears or disappears and not on every
    // selection-bearing transaction.
    const reference = findDecisionReference(selection.text);
    setCitedReference((current) =>
      current === reference ? current : reference,
    );
    handleCaretMoved(selection.from);
  });

  // The editor's props live in the component that renders it, so the
  // selection handler and the menu entry are handed over to it.
  useExternalSyncEffect(() => {
    selectionRef.current = handleSelection;
    return () => {
      selectionRef.current = null;
    };
  }, [selectionRef, handleSelection]);
  useExternalSyncEffect(() => {
    onMenuChange(
      citedReference === null
        ? null
        : {
            customContextMenuItems: [
              {
                id: CHECK_CITATION_CONTEXT_ID,
                label: t("docxCitationCheck.action"),
                requiresSelection: true,
                icon: <FileSearchIcon size={14} />,
              },
            ],
            onCustomContextAction: (id, range) => {
              if (id === CHECK_CITATION_CONTEXT_ID) {
                runSelectedCheck(range);
              }
            },
          },
    );
    return () => {
      onMenuChange(null);
    };
  }, [citedReference, onMenuChange, runSelectedCheck, t]);

  return (
    <CitationCheckCard
      onDismiss={citationCheck.dismiss}
      onRevealParagraph={(blockId) => {
        editorRef.current?.scrollToBlock(blockId);
      }}
      state={citationCheck.state}
    />
  );
};

/**
 * The host with the check's strings: mounted beside the editor and showing
 * nothing until a check runs, so nothing renders while the strings load.
 */
export const CitationCheckHost = (props: CitationCheckHostProps) => (
  <citationCheckCatalog.Provider fallback={null}>
    <CitationCheckHostContents {...props} />
  </citationCheckCatalog.Provider>
);
