import { useState } from "react";

import { useLayoutSyncEffect } from "@stll/ui/effects";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import type {
  FileTab,
  InspectorTab,
} from "@/components/inspector/inspector-tabs-store";
import {
  resolveFileRenameSubmission,
  splitFileName,
} from "@/lib/files/file-name-edit";
import { useRenameEntity } from "@/lib/workspaces/mutations/entities";

type UseFileTabRenameOptions = {
  tabs: readonly InspectorTab[];
};

export const useFileTabRename = ({ tabs }: UseFileTabRenameOptions) => {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const renameEntity = useRenameEntity();

  const startRename = (tab: FileTab) => {
    setEditValue(splitFileName(tab.label).baseName);
    setEditingTabId(tab.id);
  };

  // A rename request opens the editor in the render that first sees both the
  // request and its tab (the tab may arrive after the request), so it is open
  // before paint and without an extra commit. Remembering which request was
  // opened keeps a re-render from opening it again; the record goes when the
  // request does, so the same tab can be asked for again later.
  const pendingRenameTabId = useInspectorCommandStore(
    (s) => s.pendingRenameTabId,
  );
  const pendingRenameTarget =
    pendingRenameTabId === null
      ? undefined
      : tabs.find(
          (candidate): candidate is FileTab =>
            candidate.type === "pdf" && candidate.id === pendingRenameTabId,
        );
  const pendingRenameTargetId = pendingRenameTarget?.id ?? null;
  const [openedRenameTargetId, setOpenedRenameTargetId] = useState<
    string | null
  >(null);
  if (openedRenameTargetId !== pendingRenameTargetId) {
    setOpenedRenameTargetId(pendingRenameTargetId);
    if (pendingRenameTarget !== undefined) {
      setEditValue(splitFileName(pendingRenameTarget.label).baseName);
      setEditingTabId(pendingRenameTarget.id);
    }
  }
  // The request is answered once its editor is open.
  useLayoutSyncEffect(() => {
    if (pendingRenameTargetId === null) {
      return;
    }
    const store = useInspectorCommandStore.getState();
    if (store.pendingRenameTabId === pendingRenameTargetId) {
      store.clearRenameRequest();
    }
  }, [pendingRenameTargetId]);

  const commitRename = (tab: FileTab) => {
    setEditingTabId(null);
    const submission = resolveFileRenameSubmission({
      draft: editValue,
      currentName: tab.label,
    });
    if (submission.type === "discard") {
      return;
    }
    renameEntity.mutate({
      workspaceId: tab.workspaceId,
      entityId: tab.entityId,
      name: submission.name,
    });
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
