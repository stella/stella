import { useCallback, useLayoutEffect, useState } from "react";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type {
  FileTab,
  InspectorTab,
} from "@/components/inspector/inspector-tabs-store";
import { useRenameEntity } from "@/lib/workspaces/mutations/entities";

type UseFileTabRenameOptions = {
  tabs: readonly InspectorTab[];
};

export const useFileTabRename = ({ tabs }: UseFileTabRenameOptions) => {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const renameEntity = useRenameEntity();

  const startRename = useCallback((tab: FileTab) => {
    const dotIndex = tab.label.lastIndexOf(".");
    setEditValue(dotIndex > 0 ? tab.label.slice(0, dotIndex) : tab.label);
    setEditingTabId(tab.id);
  }, []);

  const pendingRenameTabId = useInspectorCommandStore(
    (s) => s.pendingRenameTabId,
  );
  useLayoutEffect(() => {
    if (pendingRenameTabId === null) {
      return;
    }
    const target = tabs.find(
      (candidate): candidate is FileTab =>
        candidate.type === "pdf" && candidate.id === pendingRenameTabId,
    );
    if (target) {
      // eslint-disable-next-line react/set-state-in-effect -- commit-safe store request relay; layout timing opens rename before paint when either the keyed request or async tab arrives
      startRename(target);
      const store = useInspectorCommandStore.getState();
      if (store.pendingRenameTabId === pendingRenameTabId) {
        store.clearRenameRequest();
      }
    }
  }, [pendingRenameTabId, tabs, startRename]);

  const commitRename = (tab: FileTab) => {
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
    useInspectorTabsStore.getState().updateLabel(tab.id, newName);
    renameEntity.mutate(
      { workspaceId: tab.workspaceId, entityId: tab.entityId, name: newName },
      {
        // Roll back the optimistic label; the shared rename hook
        // surfaces the failure toast.
        onError: () => {
          useInspectorTabsStore.getState().updateLabel(tab.id, previousLabel);
        },
      },
    );
  };

  return {
    commitRename,
    editingTabId,
    editValue,
    setEditingTabId,
    setEditValue,
    startRename,
  };
};
