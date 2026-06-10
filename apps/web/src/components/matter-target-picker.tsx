import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  ChevronRightIcon,
  FolderIcon,
  LayersIcon,
  SearchIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { cn } from "@stll/ui/lib/utils";

import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { resolveMatterColor } from "@/lib/matter-colors";
import { workspaceFoldersOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import type { WorkspaceFolder } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import { workspacesOptions } from "@/routes/_protected.workspaces/-queries";

/**
 * Shared "pick a matter (and optionally a folder in it)" control: matter
 * rows show the matter icon in the matter's colour, the list is filterable
 * by typing, and matters arrive ordered by most recent activity (the
 * workspaces endpoint sorts by lastActivityAt). Used by the copy/move
 * dialog and the template "save to matter" flow.
 */

export type MatterTarget = {
  workspaceId: string;
  parentId: string | null;
};

type MatterTargetPickerProps = {
  value: MatterTarget | null;
  onChange: (target: MatterTarget | null) => void;
  /** Hide one matter from the options (e.g. the source of a copy). */
  excludeWorkspaceId?: string | undefined;
  /** Offer a folder picker for the selected matter. Defaults to true. */
  showFolderPicker?: boolean | undefined;
};

export const MatterTargetPicker = ({
  value,
  onChange,
  excludeWorkspaceId,
  showFolderPicker = true,
}: MatterTargetPickerProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data } = useQuery(workspacesOptions(activeOrganizationId));

  // The endpoint returns matters ordered by most recent activity; keep that
  // order so the matter the user just touched is on top.
  const matters = (data?.workspaces ?? []).filter(
    (w) => w.id !== excludeWorkspaceId,
  );

  const query = search.trim().toLowerCase();
  const visibleMatters =
    query === ""
      ? matters
      : matters.filter(
          (w) =>
            w.name.toLowerCase().includes(query) ||
            (w.client?.displayName ?? "").toLowerCase().includes(query),
        );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t("workspaces.copyToMatter.targetMatter")}</Label>
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2"
          />
          <Input
            className="ps-8"
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("inspector.matterPicker.searchPlaceholder")}
            type="search"
            value={search}
          />
        </div>
        <ScrollArea className="border-border h-48 rounded-md border">
          <div className="p-1">
            {(() => {
              if (matters.length === 0) {
                return (
                  <p className="text-muted-foreground p-2 text-sm">
                    {t("workspaces.copyToMatter.noOtherMatters")}
                  </p>
                );
              }
              if (visibleMatters.length === 0) {
                return (
                  <p className="text-muted-foreground p-2 text-sm">
                    {t("inspector.matterPicker.noResults", { query: search })}
                  </p>
                );
              }
              return visibleMatters.map((workspace) => {
                const isSelected = value?.workspaceId === workspace.id;
                const swatch = resolveMatterColor(
                  workspace.id,
                  workspace.color,
                );
                return (
                  <button
                    className={cn(
                      "hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm",
                      isSelected && "bg-accent",
                    )}
                    key={workspace.id}
                    onClick={() =>
                      onChange({ workspaceId: workspace.id, parentId: null })
                    }
                    type="button"
                  >
                    <LayersIcon
                      aria-hidden="true"
                      className="size-4 shrink-0"
                      style={{ color: swatch }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {workspace.name}
                    </span>
                    {workspace.client?.displayName !== undefined && (
                      <span className="text-muted-foreground max-w-32 shrink-0 truncate text-xs">
                        {workspace.client.displayName}
                      </span>
                    )}
                  </button>
                );
              });
            })()}
          </div>
        </ScrollArea>
      </div>

      {showFolderPicker && value !== null && (
        <div className="space-y-2">
          <Label>{t("workspaces.copyToMatter.targetFolder")}</Label>
          <FolderPicker
            onSelect={(parentId) =>
              onChange({ workspaceId: value.workspaceId, parentId })
            }
            selectedFolderId={value.parentId}
            workspaceId={value.workspaceId}
          />
        </div>
      )}
    </div>
  );
};

type FolderPickerProps = {
  workspaceId: string;
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
};

const FolderPicker = ({
  workspaceId,
  selectedFolderId,
  onSelect,
}: FolderPickerProps) => {
  const t = useTranslations();
  const {
    data: folders,
    isLoading,
    isError,
  } = useQuery(workspaceFoldersOptions(workspaceId));

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );

  if (isLoading) {
    return (
      <div className="border-border h-32 rounded-md border p-2">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="border-border h-32 rounded-md border p-2">
        <p className="text-destructive text-sm">{t("errors.actionFailed")}</p>
      </div>
    );
  }

  const rootFolders = folders?.filter((f) => f.parentId === null) ?? [];

  const toggleExpand = (folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const renderFolder = (folder: WorkspaceFolder, depth: number) => {
    const children = folders?.filter((f) => f.parentId === folder.entityId);
    const hasChildren = children && children.length > 0;
    const isExpanded = expandedFolders.has(folder.entityId);
    const isSelected = selectedFolderId === folder.entityId;

    return (
      <div key={folder.entityId}>
        <div
          className="flex items-center gap-1"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {hasChildren ? (
            <button
              className="hover:bg-muted rounded p-0.5"
              aria-expanded={isExpanded}
              aria-label={folder.name}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(folder.entityId);
              }}
              type="button"
            >
              <ChevronRightIcon
                className={cn(
                  "size-3 transition-transform",
                  isExpanded && "rotate-90",
                )}
              />
            </button>
          ) : (
            <span className="w-4" />
          )}
          <button
            className={cn(
              "hover:bg-accent flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-start text-sm",
              isSelected && "bg-accent",
            )}
            onClick={() => onSelect(folder.entityId)}
            type="button"
          >
            <FolderIcon className="size-4 shrink-0" />
            <span className="truncate">{folder.name}</span>
          </button>
        </div>
        {hasChildren && isExpanded && (
          <div>{children.map((child) => renderFolder(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <ScrollArea className="border-border h-32 rounded-md border">
      <div className="p-1">
        <button
          className={cn(
            "hover:bg-accent flex w-full items-center gap-1 rounded px-2 py-1 text-start text-sm",
            selectedFolderId === null && "bg-accent",
          )}
          onClick={() => onSelect(null)}
          type="button"
        >
          <span className="text-muted-foreground">
            {t("workspaces.copyToMatter.rootFolder")}
          </span>
        </button>
        {rootFolders.map((folder) => renderFolder(folder, 0))}
      </div>
    </ScrollArea>
  );
};
