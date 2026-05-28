import { useCallback, useEffect, useRef, useState } from "react";

import { useTranslations } from "use-intl";

import type { DocxCompatibility } from "@stll/folio";
import { stellaToast } from "@stll/ui/components/toast";

import { DOCX_MIME } from "@/lib/consts";
import type { DocxBrowserEditorActions } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor";
import { getDocxEditBlockReason } from "@/routes/_protected.workspaces/$workspaceId/-components/docx/docx-browser-editor.logic";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type {
  FileTab,
  InspectorTab,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

type UseDocxTabEditSessionOptions = {
  tabs: readonly InspectorTab[];
};

export const useDocxTabEditSession = ({
  tabs,
}: UseDocxTabEditSessionOptions) => {
  const t = useTranslations();
  const [editingDocxTabId, setEditingDocxTabId] = useState<string | null>(null);
  const [flashingDocxEditTabId, setFlashingDocxEditTabId] = useState<
    string | null
  >(null);
  const flashDocxEditTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const docxActionsRef = useRef(new Map<string, DocxBrowserEditorActions>());
  const [docxScrollTopByTab, setDocxScrollTopByTab] = useState<
    Map<string, number>
  >(() => new Map());
  const [docxCompatibilityByTab, setDocxCompatibilityByTab] = useState<
    Map<string, DocxCompatibility>
  >(() => new Map());

  const handleStartDocxEdit = useCallback(
    async (tabId: string) => {
      const compatibility = docxCompatibilityByTab.get(tabId);
      const blockReason = getDocxEditBlockReason({
        canSafelyEdit: compatibility?.canSafelyEdit,
      });
      if (blockReason === "pendingCompatibility") {
        stellaToast.info(t("folio.checkingDocxEditTitle"), {
          description: t("folio.checkingDocxEditDescription"),
        });
        return;
      }

      if (blockReason === "unsafe") {
        stellaToast.warning(t("folio.unsupportedDocxEditTitle"), {
          description: t("folio.unsupportedDocxEditDescription"),
        });
        return;
      }

      if (editingDocxTabId !== null && editingDocxTabId !== tabId) {
        const currentAction = docxActionsRef.current.get(editingDocxTabId);
        if (currentAction !== undefined) {
          await currentAction.cancel();
        }
        docxActionsRef.current.delete(editingDocxTabId);
        setEditingDocxTabId((current) =>
          current === editingDocxTabId ? null : current,
        );
      }

      setEditingDocxTabId(tabId);
      docxActionsRef.current.get(tabId)?.unlock();
    },
    [docxCompatibilityByTab, editingDocxTabId, t],
  );

  const flashDocxEditButton = useCallback((tabId: string) => {
    if (flashDocxEditTimerRef.current !== null) {
      clearTimeout(flashDocxEditTimerRef.current);
    }
    setFlashingDocxEditTabId(tabId);
    flashDocxEditTimerRef.current = setTimeout(() => {
      setFlashingDocxEditTabId(null);
      flashDocxEditTimerRef.current = null;
    }, 2200);
  }, []);

  useEffect(
    () => () => {
      if (flashDocxEditTimerRef.current !== null) {
        clearTimeout(flashDocxEditTimerRef.current);
      }
    },
    [],
  );

  const pendingDocxEditTabId = useInspectorStore((s) => s.pendingDocxEditTabId);
  const clearDocxEditRequest = useInspectorStore((s) => s.clearDocxEditRequest);
  useEffect(() => {
    if (pendingDocxEditTabId === null) {
      return;
    }
    const target = tabs.find(
      (candidate): candidate is FileTab =>
        candidate.type === "pdf" && candidate.id === pendingDocxEditTabId,
    );
    if (!target || target.mimeType !== DOCX_MIME) {
      return;
    }
    if (editingDocxTabId === target.id) {
      clearDocxEditRequest();
      return;
    }
    const compatibility = docxCompatibilityByTab.get(target.id);
    // Wait for the compatibility check to finish — map gets the
    // entry only once the probe lands. The direct-click and
    // requestEditMode paths in docx-browser-editor already queue
    // silently via inspector.requestDocxEdit, so the toast that used
    // to fire prematurely no longer triggers from those paths.
    if (!compatibility) {
      return;
    }
    void handleStartDocxEdit(target.id);
    clearDocxEditRequest();
  }, [
    pendingDocxEditTabId,
    tabs,
    editingDocxTabId,
    docxCompatibilityByTab,
    handleStartDocxEdit,
    clearDocxEditRequest,
  ]);

  return {
    docxActionsRef,
    docxCompatibilityByTab,
    docxScrollTopByTab,
    editingDocxTabId,
    flashingDocxEditTabId,
    flashDocxEditButton,
    handleStartDocxEdit,
    setDocxCompatibilityByTab,
    setDocxScrollTopByTab,
    setEditingDocxTabId,
  };
};
