/**
 * SuggestionsFacet — AI-suggested edits rendered inside the
 * inspector tab. Reads the editor handles (ref, unlock callback,
 * editable state) for the active entity from the active-DOCX
 * registry, then delegates to the shared ReviewPanel in embedded
 * mode (no outer chrome — the facet bar above already provides the
 * title).
 *
 * In sidepeek the DocxBrowserEditor unmounts when the user
 * switches off the preview facet, so the registry registration
 * disappears with it. We still render the panel — the suggestions
 * list, redline previews, and metadata stay readable. Apply paths
 * that need a live editor (Accept) handle the missing-ref case
 * inside the panel; if the user wants to apply, they can flip back
 * to Preview to remount the editor.
 */

import { useRef } from "react";

import type { DocxEditorRef } from "@stll/folio";
import { useShallow } from "zustand/react/shallow";

import { useActiveDocxStore } from "@/components/ai-suggestions/active-docx-store";
import { ReviewPanel } from "@/components/ai-suggestions/review-panel";

type SuggestionsFacetProps = {
  entityId: string;
};

export const SuggestionsFacet = ({ entityId }: SuggestionsFacetProps) => {
  const registration = useActiveDocxStore(
    useShallow((state) => state.byEntityId[entityId]?.registration),
  );

  // Stable empty ref for unregistered entities — keeps the panel
  // renderable and gives accept handlers a safe `.current` they
  // can no-op on.
  const fallbackEditorRef = useRef<DocxEditorRef | null>(null);

  return (
    <ReviewPanel
      docxEditable={registration?.editable ?? false}
      docxEditorRef={registration?.editorRef ?? fallbackEditorRef}
      embedded
      entityId={entityId}
      requestDocxEditMode={registration?.requestEditMode}
    />
  );
};
