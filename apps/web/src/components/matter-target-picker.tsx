import { useRef, useState } from "react";

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
  matterFolderPath,
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
 * Handles the case where the user types a new folder name in the picker. The
 * folder is created here, just before the caller's write (copy, move, save),
 * and the matter's folder tree is refreshed.
 *
 * Returns a `Result` whose value is a `ResolvedMatterTarget`:
 * - `workspaceId`: the chosen matter, unchanged from the input.
 * - `parentId`: the folder to write into. For a `pending` target this is the
 *   id of the folder just created; for an `existing` target it is the input's
 *   `parentId` (`null` means the matter root).
 * The error branch carries the failed folder creation; nothing was written.
 *
 * Callers must replace a `pending` target with the resolved one, or a retry
 * after a failed write creates the folder again; the folder is kept on
 * failure since an empty folder beats a duplicate.
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

/**
 * Shared "pick a matter (and optionally a folder in it)" control. Matter rows
 * show the matter icon in its colour, the list filters as you type, and
 * matters arrive ordered by most recent activity (the workspaces endpoint
 * sorts by lastActivityAt).
 */
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
  /** Set by Escape so the blur that follows unmounting does not stage the draft. */
  const draftCancelledRef = useRef(false);

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

  /**
   * Reveal a destination: the folder itself and every folder above it. The
   * new-folder row lives inside `value.parentId`, so a collapsed ancestor
   * anywhere up the chain would hide it.
   */
  const expandFolderPath = (folderId: string | null) => {
    if (folders === undefined) {
      return;
    }
    const path = matterFolderPath(folders, folderId);
    if (path.length === 0) {
      return;
    }
    setExpandedFolders((prev) => new Set([...prev, ...path]));
  };

  /**
   * Stage a folder under whatever is selected now; it is created on submit.
   * Runs on Enter and on blur, so a name typed straight before clicking the
   * dialog's submit button is not dropped. An empty name closes the input.
   */
  const stageFolder = () => {
    const staged = stageMatterFolder(value, draftName ?? "");
    if (staged === null) {
      setDraftName(null);
      return;
    }
    onChange(staged);
    expandFolderPath(staged.parentId);
    setDraftName(null);
  };

  /**
   * The folder about to be created: the draft input while its name is typed,
   * then the staged row. Both are the same thing at different moments, so one
   * node renders them and the preview cannot sit somewhere the folder will not.
   */
  const newFolderSlot = (() => {
    if (draftName !== null) {
      return (
        <Input
          aria-label={t("workspaces.newFolder")}
          autoFocus
          className="h-7 min-w-0 flex-1 px-2 text-sm"
          maxLength={MAX_FOLDER_NAME_LENGTH}
          onBlur={() => {
            if (draftCancelledRef.current) {
              draftCancelledRef.current = false;
              return;
            }
            stageFolder();
          }}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              stageFolder();
            }
            if (e.key === "Escape") {
              // Cancel only the draft; the enclosing dialog dismisses on Escape.
              e.stopPropagation();
              draftCancelledRef.current = true;
              setDraftName(null);
            }
          }}
          placeholder={t("workspaces.newFolder")}
          value={draftName}
        />
      );
    }
    if (pendingFolder !== null) {
      return (
        <div className="bg-accent flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-sm">
          <EntityKindIcon className="size-4 shrink-0" kind="folder" />
          <BidiText as="span" className="truncate">
            {pendingFolder.name}
          </BidiText>
        </div>
      );
    }
    return null;
  })();

  /**
   * Called from the two positions that can hold the slot, both keyed off
   * `value.parentId`: the destination the folder will be created in.
   */
  const renderNewFolderSlot = (depth: number) =>
    newFolderSlot === null ? null : (
      <div
        className="flex items-center gap-1"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <span className="w-4" />
        {newFolderSlot}
      </div>
    );

  const newFolderButton =
    canCreate && draftName === null ? (
      <button
        className="hover:bg-accent text-muted-foreground flex w-full items-center gap-1 rounded px-2 py-1 text-start text-sm"
        onClick={() => {
          draftCancelledRef.current = false;
          setDraftName("");
          expandFolderPath(value.parentId);
        }}
        type="button"
      >
        <FolderPlusIcon className="size-4 shrink-0" />
        <span className="truncate">{t("workspaces.newFolder")}</span>
      </button>
    ) : null;

  const renderFolder = (folder: WorkspaceFolder, depth: number) => {
    const children = folders
      ? folders.filter((f) => f.parentId === folder.entityId)
      : [];
    const hasNewFolderSlot =
      newFolderSlot !== null && value.parentId === folder.entityId;
    const hasChildren = children.length > 0 || hasNewFolderSlot;
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
            {hasNewFolderSlot && renderNewFolderSlot(depth + 1)}
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
        {value.parentId === null && renderNewFolderSlot(0)}
        {newFolderButton}
      </div>
    </ScrollArea>
  );
};
