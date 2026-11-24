import { useState } from "react";
import type { RefObject } from "react";

import type { EditorView } from "@tiptap/pm/view";

import type { Document } from "@stll/folio-react";

import { useAutocompleteStream } from "@/components/autocomplete/use-autocomplete-stream";
import type { DocxEditorRef } from "@/components/docx/app-docx-editor";
import { useDocxCitationCheck } from "@/components/docx/citation-check/use-docx-citation-check";

import {
  useDocxAnonymizationHighlights,
  useDocxAnonymizationSelection,
} from "./use-docx-anonymization";

type UseDocxEditorViewOptions = {
  editorRef: RefObject<DocxEditorRef | null>;
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

/**
 * The live ProseMirror view Folio hands back through `onEditorViewReady`,
 * and the integrations that run against it: inline autocomplete, the
 * anonymization decorations and the citation check.
 */
export const useDocxEditorView = ({
  editorRef,
  entityId,
  fieldId,
  workspaceId,
}: UseDocxEditorViewOptions) => {
  // Track the live ProseMirror view so we can dispatch the
  // workspace anonymization-term list into the decoration plugin
  // installed inside Folio. The anonymization hook re-pushes the
  // term list whenever it (or the view) changes.
  const [editorView, setEditorView] = useState<EditorView | null>(null);

  // Inline autocomplete (ghost-text + "stella" caret). Behind a
  // dev gate while the feature is shaking out; promotes to a real
  // toggle once retrieval grounding is wired and the audit-log
  // table exists. The hook installs a transaction wrapper on the
  // view and tears down on unmount.
  useAutocompleteStream({
    editorRef,
    view: editorView,
    enabled: import.meta.env.DEV,
    language: "en",
  });
  const anonymization = useDocxAnonymizationHighlights({
    editorView,
    entityId,
    fieldId,
    workspaceId,
  });
  const anonymizationSelectionProps = useDocxAnonymizationSelection(fieldId);
  // Wraps the anonymization selection bridge; off, it hands it back as is.
  const citationCheck = useDocxCitationCheck({
    editorRef,
    onSelectionTextChange: anonymizationSelectionProps.onSelectionTextChange,
  });

  return {
    editorView,
    /**
     * The editor's `onChange`, locked or not: it notes each change for
     * entity detection, then hands it to `onEdit`, if any.
     */
    editorChange:
      (onEdit: ((document: Document) => void) | null) =>
      (document: Document) => {
        anonymization.noteDocumentChanged();
        onEdit?.(document);
      },
    /**
     * `DocxEditor` props that capture the view, bridge anonymization and
     * carry the citation check's menu entry.
     */
    editorProps: {
      anonymizationTerms: anonymization.anonymizationTerms,
      onAnonymizationMatchesChange: anonymization.onAnonymizationMatchesChange,
      ...anonymizationSelectionProps,
      ...citationCheck.editorProps,
      onEditorViewReady: setEditorView,
    },
    /** Rendered over the editor; null unless a citation check has run. */
    citationCheckCard: citationCheck.card,
  };
};
