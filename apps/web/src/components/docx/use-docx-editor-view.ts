import { useState } from "react";

import type { EditorView } from "prosemirror-view";

import { useAutocompleteStream } from "@/components/autocomplete/use-autocomplete-stream";

import {
  useDocxAnonymizationHighlights,
  useDocxAnonymizationSelection,
} from "./use-docx-anonymization";

type UseDocxEditorViewOptions = {
  entityId: string;
  fieldId: string;
  workspaceId: string;
};

/**
 * The live ProseMirror view Folio hands back through `onEditorViewReady`,
 * and the integrations that run against it: inline autocomplete and the
 * anonymization decorations.
 */
export const useDocxEditorView = ({
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
  useAutocompleteStream(editorView, {
    enabled: import.meta.env.DEV,
    language: "en",
  });
  const onAnonymizationMatchesChange = useDocxAnonymizationHighlights({
    editorView,
    entityId,
    fieldId,
    workspaceId,
  });
  const anonymizationSelectionProps = useDocxAnonymizationSelection(fieldId);

  return {
    editorView,
    /** `DocxEditor` props that capture the view and bridge anonymization. */
    editorProps: {
      onAnonymizationMatchesChange,
      ...anonymizationSelectionProps,
      onEditorViewReady: setEditorView,
    },
  };
};
