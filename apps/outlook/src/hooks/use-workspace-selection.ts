import { useState } from "react";

import {
  confirmedWorkspaceId,
  filterWorkspaces,
  suggestWorkspaceId,
} from "@/lib/workspace-selection";
import type { MailSnapshot, WorkspaceSummary } from "@/types";

type UseWorkspaceSelection = {
  filteredWorkspaces: WorkspaceSummary[];
  query: string;
  selectedWorkspace: WorkspaceSummary | null;
  selectedWorkspaceId: string | null;
  setQuery: (value: string) => void;
  setSelectedWorkspaceId: (workspaceId: string) => void;
  suggestedWorkspaceId: string | null;
};

export const useWorkspaceSelection = ({
  snapshot,
  workspaces,
}: {
  snapshot: MailSnapshot | null;
  workspaces: WorkspaceSummary[];
}): UseWorkspaceSelection => {
  const [query, setQuery] = useState("");
  const [explicitWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );

  const suggestedWorkspaceId = snapshot
    ? suggestWorkspaceId({ snapshot, workspaces })
    : null;

  const selectedWorkspaceId = confirmedWorkspaceId({
    explicitWorkspaceId,
    suggestedWorkspaceId,
  });

  const filteredWorkspaces = filterWorkspaces({ query, workspaces });
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    null;

  return {
    filteredWorkspaces,
    query,
    selectedWorkspace,
    selectedWorkspaceId,
    setQuery,
    setSelectedWorkspaceId,
    suggestedWorkspaceId,
  };
};
