import { useEffect, useState } from "react";

import type { MailSnapshot, WorkspaceSummary } from "@/types";

const MIN_SUGGEST_TERM_LENGTH = 3;

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
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );

  const suggestedWorkspaceId = snapshot
    ? suggestWorkspaceId({ snapshot, workspaces })
    : null;

  useEffect(() => {
    if (!selectedWorkspaceId && suggestedWorkspaceId) {
      setSelectedWorkspaceId(suggestedWorkspaceId);
    }
  }, [selectedWorkspaceId, suggestedWorkspaceId]);

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

const filterWorkspaces = ({
  query,
  workspaces,
}: {
  query: string;
  workspaces: WorkspaceSummary[];
}): WorkspaceSummary[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return workspaces;
  }

  return workspaces.filter((workspace) => {
    const haystack = [workspace.name, workspace.reference, workspace.clientName]
      .filter((value): value is string => !!value)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
};

const suggestWorkspaceId = ({
  snapshot,
  workspaces,
}: {
  snapshot: MailSnapshot;
  workspaces: WorkspaceSummary[];
}): string | null => {
  const haystack = [
    snapshot.subject,
    snapshot.bodyText,
    snapshot.from?.email,
    ...snapshot.attachments.map((attachment) => attachment.name),
  ]
    .filter((value): value is string => !!value)
    .join(" ")
    .toLowerCase();

  let best: { score: number; workspaceId: string } | null = null;
  for (const workspace of workspaces) {
    const terms = [workspace.name, workspace.reference, workspace.clientName]
      .filter((value): value is string => !!value)
      .flatMap((value) => value.toLowerCase().split(/[\s/._-]+/u))
      .filter((term) => term.length >= MIN_SUGGEST_TERM_LENGTH);
    const score = terms.reduce(
      (total, term) => total + (haystack.includes(term) ? 1 : 0),
      0,
    );
    if (score > 0 && (!best || score > best.score)) {
      best = { score, workspaceId: workspace.id };
    }
  }

  return best?.workspaceId ?? workspaces.at(0)?.id ?? null;
};
