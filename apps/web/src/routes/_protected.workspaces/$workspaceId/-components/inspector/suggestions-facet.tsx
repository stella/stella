/**
 * SuggestionsFacet — AI-suggested edits rendered inside the
 * inspector tab. Reads the editor handles (ref, unlock callback,
 * editable state) for the active entity from the active-DOCX
 * registry, then delegates to the shared ReviewPanel in embedded
 * mode (no outer chrome — the facet bar above already provides the
 * title).
 *
 * Sidepeek-no-editor escape hatch:
 * In sidepeek the DocxBrowserEditor unmounts when the user
 * switches off the preview facet, so the registry registration
 * disappears with it. The Accept paths in the embedded review panel
 * then no-op. As a quick fix the sidepeek caller can pass
 * `onMissingEditor`; we fire it on mount whenever no editor is
 * registered and let the parent route to the DOCX main view, where
 * the editor is mounted by default and Accept actually works.
 *
 * TODO: replace this hop with a lightweight in-app approval flow
 * (apply/reject without needing the full editor mounted) so the
 * sidepeek doesn't have to context-switch.
 */

import { useEffect, useRef } from "react";

import type { DocxEditorRef } from "@stll/folio";
import { useShallow } from "zustand/react/shallow";

import { useActiveDocxStore } from "@/components/ai-suggestions/active-docx-store";
import { ReviewPanel } from "@/components/ai-suggestions/review-panel";

type SuggestionsFacetProps = {
  entityId: string;
  /**
   * Called once when this facet renders without a registered DOCX
   * editor for the entity. Sidepeek wires this to a navigation
   * toward the main DOCX view so Accept has a live editor to write
   * into. Fires at most once per facet mount — the parent's
   * navigate causes a re-render which would otherwise re-enter the
   * effect; we latch via a ref so the callback never re-fires.
   */
  onMissingEditor?: () => void;
};

export const SuggestionsFacet = ({
  entityId,
  onMissingEditor,
}: SuggestionsFacetProps) => {
  const registration = useActiveDocxStore(
    useShallow((state) => state.byEntityId[entityId]?.registration),
  );

  // Stable empty ref for unregistered entities — keeps the panel
  // renderable and gives accept handlers a safe `.current` they
  // can no-op on.
  const fallbackEditorRef = useRef<DocxEditorRef | null>(null);

  // Latch the latest callback so the effect dep list can stay
  // narrow (`[registration]`) — the callback ref doesn't drive
  // re-runs and the parent passing a new function on every render
  // can't loop us.
  const onMissingEditorRef = useRef(onMissingEditor);
  onMissingEditorRef.current = onMissingEditor;
  // Latch the dispatch itself: once we've kicked the caller for a
  // missing editor, don't ask again until either this facet
  // unmounts or a registration appears. Without this guard the
  // parent's navigate triggers a re-render that re-enters the
  // effect and fires another navigate — an unstoppable loop.
  const hasDispatchedRef = useRef(false);

  useEffect(() => {
    if (registration !== undefined) {
      hasDispatchedRef.current = false;
      return;
    }
    if (hasDispatchedRef.current) {
      return;
    }
    hasDispatchedRef.current = true;
    onMissingEditorRef.current?.();
  }, [registration]);

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
