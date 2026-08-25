import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { ChevronRightIcon, FolderPlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { MatterIcon } from "@/components/matter-icon";
import {
  MAX_FOLDER_NAME_LENGTH,
  resolveMatterTarget,
  stageMatterFolder,
} from "@/components/matter-target-picker.logic";
import type { MatterTarget } from "@/components/matter-target-picker.logic";
import Tooltip from "@/components/tooltip";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { usePermissions } from "@/hooks/use-permissions";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { useCreateEntities } from "@/lib/workspaces/mutations/entities";
import { workspacesOptions } from "@/lib/workspaces/queries";
import {
  entitiesKeys,
  workspaceFoldersOptions,
} from "@/lib/workspaces/queries/entities";
import type { WorkspaceFolder } from "@/lib/workspaces/queries/entities";

/**
 * Shared "pick a matter (and optionally a folder in it)" control. Matter rows
 * show the matter icon in its colour, the list filters as you type, and
 * matters arrive ordered by most recent activity (the workspaces endpoint
 * sorts by lastActivityAt).
 *
 * `useResolveMatterTarget` creates a staged folder before a write and
 * refreshes the target's folder tree. Callers must replace a `pending` target
 * with the resolved one, or a retry after a failed write creates the folder
 * again; the folder is kept on failure since an empty folder beats a duplicate.
 */
export const useResolveMatterTarget = () => {
  const createEntities = useCreateEntities();
  const queryClient = useQueryClient();

  return async (target: MatterTarget) => {
    const resolved = await resolveMatterTarget(
      target,
      async ({ workspaceId, parentId, name }) =>
        await createEntities.mutateAsync({
          type: "manual-input",
          kind: "folder",
          workspaceId,
          parentId,
          name,
        }),
    );
    if (target.type === "pending" && Result.isOk(resolved)) {
      // Not awaited: the active folder-tree query refetches on invalidation,
      // and the caller's write must not wait behind it.
      detached(
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(target.workspaceId),
        }),
        "matter-target-picker.invalidate-folders",
      );
    }
    return resolved;
  };
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
  const matters = data
    ? data.workspaces.filter((w) => w.id !== excludeWorkspaceId)
    : [];

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
        <Input
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("inspector.matterPicker.searchPlaceholder")}
          type="search"
          value={search}
        />
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
                return (
                  <button
                    className={cn(
                      "hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm",
                      isSelected && "bg-accent",
                    )}
                    key={workspace.id}
                    onClick={() =>
                      onChange({
                        type: "existing",
                        workspaceId: workspace.id,
                        parentId: null,
                      })
                    }
                    type="button"
                  >
                    <MatterIcon
                      className="size-4 shrink-0"
                      matter={{ id: workspace.id, color: workspace.color }}
                    />
                    <BidiText as="span" className="min-w-0 flex-1 truncate">
                      {workspace.name}
                    </BidiText>
                    {workspace.client?.displayName !== undefined && (
                      <BidiText
                        as="span"
                        className="text-muted-foreground max-w-32 shrink-0 truncate text-xs"
                      >
                        {workspace.client.displayName}
                      </BidiText>
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
          {/* Keyed by matter so expansion and the new-folder draft cannot
              carry over to a different matter's tree. */}
          <FolderPicker
            key={value.workspaceId}
            onChange={onChange}
            value={value}
          />
        </div>
      )}
    </div>
  );
};

type FolderPickerProps = {
  value: MatterTarget;
  onChange: (target: MatterTarget) => void;
};

const FolderPicker = ({ value, onChange }: FolderPickerProps) => {
  const t = useTranslations();
  const canCreate = usePermissions({ entity: ["create"] });
  const workspaceId = value.workspaceId;
  const {
    data: folders,
    isLoading,
    isError,
  } = useQuery(workspaceFoldersOptions(workspaceId));

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  /** `null` while the new-folder row is a button; a string while it is an input. */
  const [draftName, setDraftName] = useState<string | null>(null);

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

  const rootFolders = folders ? folders.filter((f) => f.parentId === null) : [];
  const pendingFolder = value.type === "pending" ? value : null;

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

  /** Stage a folder under whatever is selected now; it is created on submit. */
  const stageFolder = () => {
    const staged = stageMatterFolder(value, draftName ?? "");
    if (staged === null) {
      return;
    }
    onChange(staged);
    if (staged.parentId !== null) {
      const parentId = staged.parentId;
      setExpandedFolders((prev) => new Set(prev).add(parentId));
    }
    setDraftName(null);
  };

  const newFolderRow = (() => {
    if (!canCreate) {
      return null;
    }
    if (draftName === null) {
      return (
        <button
          className="hover:bg-accent text-muted-foreground flex w-full items-center gap-1 rounded px-2 py-1 text-start text-sm"
          onClick={() => setDraftName("")}
          type="button"
        >
          <FolderPlusIcon className="size-4 shrink-0" />
          <span className="truncate">{t("workspaces.newFolder")}</span>
        </button>
      );
    }
    return (
      <Input
        aria-label={t("workspaces.newFolder")}
        autoFocus
        className="h-7 px-2 text-sm"
        maxLength={MAX_FOLDER_NAME_LENGTH}
        onChange={(e) => setDraftName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            stageFolder();
          }
          if (e.key === "Escape") {
            // Cancel only the draft; the enclosing dialog dismisses on Escape.
            e.stopPropagation();
            setDraftName(null);
          }
        }}
        placeholder={t("workspaces.newFolder")}
        value={draftName}
      />
    );
  })();

  const renderPendingFolder = (name: string, depth: number) => (
    <div
      className="flex items-center gap-1"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <span className="w-4" />
      <div className="bg-accent flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-sm">
        <EntityKindIcon className="size-4 shrink-0" kind="folder" />
        <BidiText as="span" className="truncate">
          {name}
        </BidiText>
      </div>
    </div>
  );

  const renderFolder = (folder: WorkspaceFolder, depth: number) => {
    const children = folders
      ? folders.filter((f) => f.parentId === folder.entityId)
      : [];
    const pendingChild =
      pendingFolder?.parentId === folder.entityId ? pendingFolder : null;
    const hasChildren = children.length > 0 || pendingChild !== null;
    const isExpanded = expandedFolders.has(folder.entityId);
    const isSelected =
      value.type === "existing" && value.parentId === folder.entityId;

    return (
      <div key={folder.entityId}>
        <div
          className="flex items-center gap-1"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {hasChildren ? (
            <Tooltip
              content={folder.name}
              render={
                <button
                  className="hover:bg-muted rounded p-0.5"
                  aria-expanded={isExpanded}
                  aria-label={folder.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(folder.entityId);
                  }}
                  type="button"
                />
              }
            >
              <DirectionalIcon
                className={cn(
                  "size-3 transition-transform",
                  isExpanded && "rotate-90",
                )}
                flip={!isExpanded}
                icon={ChevronRightIcon}
              />
            </Tooltip>
          ) : (
            <span className="w-4" />
          )}
          <button
            className={cn(
              "hover:bg-accent flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-start text-sm",
              isSelected && "bg-accent",
            )}
            onClick={() =>
              onChange({
                type: "existing",
                workspaceId,
                parentId: folder.entityId,
              })
            }
            type="button"
          >
            <EntityKindIcon className="size-4 shrink-0" kind="folder" />
            <BidiText as="span" className="truncate">
              {folder.name}
            </BidiText>
          </button>
        </div>
        {hasChildren && isExpanded && (
          <div>
            {children.map((child) => renderFolder(child, depth + 1))}
            {pendingChild !== null &&
              renderPendingFolder(pendingChild.name, depth + 1)}
          </div>
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
            value.type === "existing" && value.parentId === null && "bg-accent",
          )}
          onClick={() =>
            onChange({ type: "existing", workspaceId, parentId: null })
          }
          type="button"
        >
          <span className="text-muted-foreground">
            {t("workspaces.copyToMatter.rootFolder")}
          </span>
        </button>
        {rootFolders.map((folder) => renderFolder(folder, 0))}
        {pendingFolder !== null &&
          pendingFolder.parentId === null &&
          renderPendingFolder(pendingFolder.name, 0)}
        {newFolderRow}
      </div>
    </ScrollArea>
  );
};
