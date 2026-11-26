import { useState } from "react";

import { useExternalSyncEffect } from "@stll/ui/effects";

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

  // A rename asked for from outside the strip (a command, a menu) waits in
  // the store until its tab is here. The render that sees both opens the
  // editor, so it is open in the commit the request or the tab arrives in;
  // the request is then cleared, which re-arms the same tab for a later one.
  const pendingRenameTabId = useInspectorCommandStore(
    (s) => s.pendingRenameTabId,
  );
  const renameTarget =
    pendingRenameTabId === null
      ? undefined
      : tabs.find(
          (candidate): candidate is FileTab =>
            candidate.type === "pdf" && candidate.id === pendingRenameTabId,
        );
  const requestedTabId = renameTarget?.id ?? null;
  const [startedTabId, setStartedTabId] = useState<string | null>(null);
  if (requestedTabId !== startedTabId) {
    setStartedTabId(requestedTabId);
    if (renameTarget !== undefined) {
      startRename(renameTarget);
    }
  }
  useExternalSyncEffect(() => {
    if (requestedTabId === null) {
      return;
    }
    const store = useInspectorCommandStore.getState();
    if (store.pendingRenameTabId === requestedTabId) {
      store.clearRenameRequest();
    }
  }, [requestedTabId]);

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
