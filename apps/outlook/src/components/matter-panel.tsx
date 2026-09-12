import { ExternalLinkIcon, FileTextIcon } from "lucide-react";

import { Input } from "@stll/ui/components/input";
import { cn } from "@stll/ui/lib/utils";

import { Notice } from "@/components/notice";
import { Panel, PanelTitle } from "@/components/panel";
import type { Translate } from "@/components/panel";
import { env } from "@/env";
import type { WorkspaceSummary } from "@/types";

const MAX_VISIBLE_MATTERS = 12;

type MatterPanelProps = {
  onQueryChange: (value: string) => void;
  onSelect: (workspaceId: string) => void;
  query: string;
  selectedWorkspaceId: string | null;
  suggestedWorkspaceId: string | null;
  t: Translate;
  workspaceError: string | null;
  workspaces: WorkspaceSummary[];
};

export const MatterPanel = ({
  onQueryChange,
  onSelect,
  query,
  selectedWorkspaceId,
  suggestedWorkspaceId,
  t,
  workspaceError,
  workspaces,
}: MatterPanelProps) => (
  <Panel>
    <PanelTitle icon={<FileTextIcon />} title={t("chooseMatter")} />
    {workspaceError ? (
      <Notice role="alert" title={workspaceError} tone="warning">
        <a
          className="text-primary inline-flex items-center gap-1 underline"
          href={env.stellaWebUrl}
          rel="noreferrer"
          target="_blank"
        >
          {t("openStella")}
          <ExternalLinkIcon className="size-3" />
        </a>
        <span> {t("signInHint")}</span>
      </Notice>
    ) : null}
    <Input
      aria-label={t("matterSearch")}
      onChange={(event) => onQueryChange(event.currentTarget.value)}
      placeholder={t("matterSearch")}
      type="search"
      value={query}
    />
    <MatterList
      onSelect={onSelect}
      selectedWorkspaceId={selectedWorkspaceId}
      suggestedWorkspaceId={suggestedWorkspaceId}
      t={t}
      workspaces={workspaces}
    />
  </Panel>
);

const MatterList = ({
  onSelect,
  selectedWorkspaceId,
  suggestedWorkspaceId,
  t,
  workspaces,
}: {
  onSelect: (workspaceId: string) => void;
  selectedWorkspaceId: string | null;
  suggestedWorkspaceId: string | null;
  t: Translate;
  workspaces: WorkspaceSummary[];
}) => {
  if (workspaces.length === 0) {
    return (
      <p className="text-muted-foreground text-xs/4.5">
        {t("noMatterResults")}
      </p>
    );
  }

  return (
    <div className="max-h-44 overflow-auto">
      <div className="grid gap-2 pe-0.5">
        {workspaces.slice(0, MAX_VISIBLE_MATTERS).map((workspace) => (
          <MatterOption
            isSelected={selectedWorkspaceId === workspace.id}
            isSuggested={workspace.id === suggestedWorkspaceId}
            key={workspace.id}
            onSelect={onSelect}
            t={t}
            workspace={workspace}
          />
        ))}
      </div>
    </div>
  );
};

const MatterOption = ({
  isSelected,
  isSuggested,
  onSelect,
  t,
  workspace,
}: {
  isSelected: boolean;
  isSuggested: boolean;
  onSelect: (workspaceId: string) => void;
  t: Translate;
  workspace: WorkspaceSummary;
}) => {
  const meta = [workspace.reference, workspace.clientName]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      aria-pressed={isSelected}
      className={cn(
        "border-input bg-popover hover:bg-accent/50 flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-start",
        isSelected && "border-ring bg-accent/50",
      )}
      onClick={() => onSelect(workspace.id)}
      type="button"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm/5 font-medium">
          {workspace.name}
        </span>
        {meta ? (
          <span className="text-muted-foreground block truncate text-xs/4.5">
            {meta}
          </span>
        ) : null}
      </span>
      {isSuggested ? (
        <span className="bg-success/12 text-success-foreground shrink-0 rounded-md px-1.5 py-0.5 text-[0.6875rem]/4 font-semibold">
          {t("suggested")}
        </span>
      ) : null}
    </button>
  );
};
