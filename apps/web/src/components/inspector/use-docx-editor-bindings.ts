import { useMemo, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import type { DocxCompatibility } from "@stll/folio-react";

import type { DocxEditorSlotBindings } from "@/components/docx/docx-editor-host.logic";
import type { DocxBrowserEditorActions } from "@/components/docx/use-docx-browser-editor-actions";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useLatestCallback } from "@/hooks/use-latest-callback";

type UseDocxEditorBindingsOptions = {
  docxActionsRef: RefObject<Map<string, DocxBrowserEditorActions>>;
  onError: () => void;
  setDocxCompatibilityByTab: Dispatch<
    SetStateAction<Map<string, DocxCompatibility>>
  >;
  setDocxScrollTopByTab: Dispatch<SetStateAction<Map<string, number>>>;
  setEditingDocxTabId: Dispatch<SetStateAction<string | null>>;
  setScaleOffsets: Dispatch<SetStateAction<Map<string, number>>>;
  tabId: string;
};

/**
 * What the hosted DOCX editor reports back to a file tab: its scroll position,
 * compatibility, collaboration state, and the field id a save produced.
 */
export const useDocxEditorBindings = ({
  docxActionsRef,
  onError,
  setDocxCompatibilityByTab,
  setDocxScrollTopByTab,
  setEditingDocxTabId,
  setScaleOffsets,
  tabId,
}: UseDocxEditorBindingsOptions) => {
  const [isCollaborationPublishable, setIsCollaborationPublishable] =
    useState(false);

  const handleScrollTopChange = (scrollTop: number) => {
    setDocxScrollTopByTab((prev) => {
      const next = new Map(prev);
      next.set(tabId, scrollTop);
      return next;
    });
  };

  // The hosted editor lives above this panel, so what it reports back travels
  // through the claim. Stable for the tab's lifetime: a claim rewritten on
  // every render of the inspector would churn the host for nothing.
  const handleClose = useLatestCallback(() => {
    // Don't touch docxActionsRef here. The editor stays mounted across
    // error -> idle transitions; only its own cleanup should release the
    // slot, otherwise the next unlock finds no entry and silently no-ops.
    setEditingDocxTabId(null);
  });
  const handleCompatibilityChange = useLatestCallback(
    (compatibility: DocxCompatibility) => {
      setDocxCompatibilityByTab((prev) => {
        if (prev.get(tabId) === compatibility) {
          return prev;
        }
        const next = new Map(prev);
        next.set(tabId, compatibility);
        return next;
      });
    },
  );
  const handleSaved = useLatestCallback((savedFieldId: string) => {
    if (savedFieldId === tabId) {
      return;
    }
    setDocxScrollTopByTab((prev) => {
      const scrollTop = prev.get(tabId);
      if (scrollTop === undefined) {
        return prev;
      }
      const next = new Map(prev);
      next.set(savedFieldId, scrollTop);
      return next;
    });
    setScaleOffsets((prev) => {
      const savedScaleOffset = prev.get(tabId);
      if (savedScaleOffset === undefined) {
        return prev;
      }
      const next = new Map(prev);
      next.set(savedFieldId, savedScaleOffset);
      return next;
    });
    useInspectorTabsStore.getState().replaceFileFieldId(tabId, savedFieldId);
  });
  const handleScrollTop = useLatestCallback(handleScrollTopChange);
  const handleCollaborationPublishableChange = useLatestCallback(
    setIsCollaborationPublishable,
  );
  const handleError = useLatestCallback(onError);
  const bindings = useMemo(
    () =>
      ({
        actionsKey: tabId,
        actionsMapRef: docxActionsRef,
        onClose: handleClose,
        onCollaborationPublishableChange: handleCollaborationPublishableChange,
        onCompatibilityChange: handleCompatibilityChange,
        onError: handleError,
        onSaved: handleSaved,
        onScrollTopChange: handleScrollTop,
      }) satisfies DocxEditorSlotBindings,
    [
      docxActionsRef,
      handleClose,
      handleCollaborationPublishableChange,
      handleCompatibilityChange,
      handleError,
      handleSaved,
      handleScrollTop,
      tabId,
    ],
  );

  return { bindings, handleScrollTopChange, isCollaborationPublishable };
};

export type DocxEditorBindings = ReturnType<typeof useDocxEditorBindings>;
