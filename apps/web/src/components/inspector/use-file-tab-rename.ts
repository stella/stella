import { useCallback, useEffect, useState } from "react";

import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { useInspectorStore } from "@/components/inspector/inspector-store";
import type {
  FileTab,
  InspectorTab,
} from "@/components/inspector/inspector-store";
import { useRenameEntity } from "@/routes/_protected.workspaces/$workspaceId/-mutations/entities";

type UseFileTabRenameOptions = {
  tabs: readonly InspectorTab[];
};

export const useFileTabRename = ({ tabs }: UseFileTabRenameOptions) => {
  const t = useTranslations();
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const renameEntity = useRenameEntity();

  const startRename = useCallback((tab: FileTab) => {
    const dotIndex = tab.label.lastIndexOf(".");
    setEditValue(dotIndex > 0 ? tab.label.slice(0, dotIndex) : tab.label);
    setEditingTabId(tab.id);
  }, []);

  const pendingRenameTabId = useInspectorStore((s) => s.pendingRenameTabId);
  const clearRenameRequest = useInspectorStore((s) => s.clearRenameRequest);
  useEffect(() => {
    if (pendingRenameTabId === null) {
      return;
    }
    const target = tabs.find(
      (candidate): candidate is FileTab =>
        candidate.type === "pdf" && candidate.id === pendingRenameTabId,
    );
    if (target) {
      startRename(target);
      clearRenameRequest();
    }
  }, [pendingRenameTabId, tabs, startRename, clearRenameRequest]);

  const commitRename = useCallback(
    (tab: FileTab) => {
      const trimmed = editValue.trim();
      if (!trimmed) {
        setEditingTabId(null);
        return;
      }

      const dotIndex = tab.label.lastIndexOf(".");
      const ext = dotIndex > 0 ? tab.label.slice(dotIndex) : "";
      const newName = trimmed + ext;

      setEditingTabId(null);

      if (newName === tab.label) {
        return;
      }

      const previousLabel = tab.label;
      useInspectorStore.getState().updateLabel(tab.id, newName);
      renameEntity.mutate(
        { workspaceId: tab.workspaceId, entityId: tab.entityId, name: newName },
        {
          onError: () => {
            useInspectorStore.getState().updateLabel(tab.id, previousLabel);
            stellaToast.add({
              title: t("errors.actionFailed"),
              type: "error",
            });
          },
        },
      );
    },
    [editValue, renameEntity, t],
  );

  return {
    commitRename,
    editingTabId,
    editValue,
    setEditingTabId,
    setEditValue,
    startRename,
  };
};
