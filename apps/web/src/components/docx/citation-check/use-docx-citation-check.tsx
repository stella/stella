/**
 * The citation check as the document editor wires it: the context-menu
 * entry on a selection that names a decision, the automatic check as the
 * caret settles in a paragraph, and the card that holds the answers.
 *
 * Everything here is off unless the organization's settings admit the
 * `citation-check` feature (the deployment flag and the organization grant
 * both decide that on the server). Off, the editor gets back the selection
 * callback it passed in and nothing else: no timer is armed and no check is
 * ever requested.
 */

import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { useTranslations } from "use-intl";

import { FileSearchIcon } from "@stll/ui/icons";

import type { DocxEditorRef } from "@/components/docx/app-docx-editor";
import { CitationCheckCard } from "@/components/docx/citation-check/citation-check-card";
import { findDecisionReference } from "@/components/docx/citation-check/citation-check.logic";
import {
  blockContaining,
  useAutomaticCitationCheck,
} from "@/components/docx/citation-check/use-automatic-citation-check";
import { useCitationCheck } from "@/components/docx/citation-check/use-citation-check";
import { detached } from "@/lib/detached";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";

const CHECK_CITATION_CONTEXT_ID = "stella.check-citation";

type TextSelection = { from: number; to: number; text: string };

type UseDocxCitationCheckOptions = {
  editorRef: RefObject<DocxEditorRef | null>;
  /** The selection callback the editor already has; always still called. */
  onSelectionTextChange: (selection: TextSelection) => void;
};

type DocxCitationCheck = {
  /** `DocxEditor` props: the selection bridge and, when on, the menu entry. */
  editorProps: {
    onSelectionTextChange: (selection: TextSelection) => void;
    customContextMenuItems?: readonly {
      id: string;
      label: string;
      requiresSelection?: boolean;
      icon?: ReactNode;
    }[];
    onCustomContextAction?: (
      id: string,
      range: { from: number; to: number },
    ) => void;
  };
  /** The answers card; null while the feature is off or nothing ran. */
  card: ReactNode;
};

export const useDocxCitationCheck = ({
  editorRef,
  onSelectionTextChange,
}: UseDocxCitationCheckOptions): DocxCitationCheck => {
  const t = useTranslations();
  const enabled = useCallerFeatureEnabled(CALLER_FEATURE.citationCheck);
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

  if (!enabled) {
    return { editorProps: { onSelectionTextChange }, card: null };
  }

  const handleSelectionTextChange = (selection: TextSelection) => {
    lastSelectionRef.current = selection;
    // Only the reference itself reaches state, so the editor re-renders when
    // the "Check citation" entry appears or disappears and not on every
    // selection-bearing transaction.
    const reference = findDecisionReference(selection.text);
    setCitedReference((current) =>
      current === reference ? current : reference,
    );
    handleCaretMoved(selection.from);
    onSelectionTextChange(selection);
  };

  const runSelectedCheck = (range: { from: number; to: number }) => {
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
  };

  return {
    editorProps: {
      onSelectionTextChange: handleSelectionTextChange,
      // Offered only where there is something to check: no entry appears on
      // a selection that names no decision.
      ...(citedReference === null
        ? {}
        : {
            customContextMenuItems: [
              {
                id: CHECK_CITATION_CONTEXT_ID,
                label: t("docxCitationCheck.action"),
                requiresSelection: true,
                icon: <FileSearchIcon size={14} />,
              },
            ],
          }),
      onCustomContextAction: (id, range) => {
        if (id === CHECK_CITATION_CONTEXT_ID) {
          runSelectedCheck(range);
        }
      },
    },
    card: (
      <CitationCheckCard
        onDismiss={citationCheck.dismiss}
        onRevealParagraph={(blockId) => {
          editorRef.current?.scrollToBlock(blockId);
        }}
        state={citationCheck.state}
      />
    ),
  };
};
