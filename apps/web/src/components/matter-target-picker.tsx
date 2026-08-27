import { type ReactNode, useRef, useState } from "react";

import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import {
  ChevronRightIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/menu";
import { ScrollArea } from "@stll/ui/scroll-area";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  withDragAnnouncementData,
  withDropAnnouncementData,
} from "@/components/drag-and-drop-live-region.logic";
import { MatterIcon } from "@/components/matter-icon";
import {
  canMoveMatterFolder,
  discardPendingMatterFolder,
  MAX_FOLDER_NAME_LENGTH,
  matterFolderPath,
  matterFolderMoveDestinations,
  reparentPendingMatterFolder,
  resolveMatterTarget,
  selectExistingMatterTarget,
  selectPendingMatterTarget,
  stageMatterFolder,
} from "@/components/matter-target-picker.logic";
import type { MatterTarget } from "@/components/matter-target-picker.logic";
import Tooltip from "@/components/tooltip";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import {
  useCreateEntities,
  useMoveEntity,
} from "@/lib/workspaces/mutations/entities";
import { workspacesOptions } from "@/lib/workspaces/queries";
import {
  entitiesKeys,
  workspaceFoldersOptions,
} from "@/lib/workspaces/queries/entities";
import type { WorkspaceFolder } from "@/lib/workspaces/queries/entities";

const MATTER_FOLDER_DRAG_TYPE = "stella.matter-folder-drag";

type MatterFolderDragSource =
  | {
      kind: "existing";
      folderId: string;
      parentId: string | null;
      name: string;
    }
  | {
      kind: "pending";
      parentId: string | null;
      name: string;
    };

type MatterFolderDragData = MatterFolderDragSource & {
  type: typeof MATTER_FOLDER_DRAG_TYPE;
};

type MatterFolderDropTarget = {
  parentId: string | null;
  name: string;
};

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isMatterFolderDragData = (
  data: Record<string | symbol, unknown>,
): data is MatterFolderDragData => {
  if (
    data["type"] !== MATTER_FOLDER_DRAG_TYPE ||
    !isNullableString(data["parentId"]) ||
    typeof data["name"] !== "string"
  ) {
    return false;
  }
  switch (data["kind"]) {
    case "existing":
      return typeof data["folderId"] === "string";
    case "pending":
      return true;
    default:
      return false;
  }
};

const canDropMatterFolder = (
  source: MatterFolderDragData,
  folders: readonly WorkspaceFolder[],
  targetParentId: string | null,
) => {
  switch (source.kind) {
    case "existing":
      return canMoveMatterFolder(folders, source.folderId, targetParentId);
    case "pending":
      return source.parentId !== targetParentId;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
};

type FolderDragDropRowProps = {
  source?: MatterFolderDragSource | undefined;
  target?: MatterFolderDropTarget | undefined;
  folders: readonly WorkspaceFolder[];
  sourceEnabled: boolean;
  targetEnabled: boolean;
  onMove: (source: MatterFolderDragData, targetParentId: string | null) => void;
  children: (options: {
    isDropTarget: boolean;
    dragHandle: ReactNode;
  }) => ReactNode;
};

const FolderDragDropRow = ({
  source,
  target,
  folders,
  sourceEnabled,
  targetEnabled,
  onMove,
  children,
}: FolderDragDropRowProps) => {
  const t = useTranslations();
  const rowRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLButtonElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isMoveMenuOpen, setIsMoveMenuOpen] = useState(false);
  const handleMove = useLatestCallback(onMove);
  const sourceKind = source?.kind;
  const sourceFolderId =
    source?.kind === "existing" ? source.folderId : undefined;
  const sourceParentId = source?.parentId;
  const sourceName = source?.name;
  const targetParentId = target?.parentId;
  const targetName = target?.name;
  const keyboardSourceData = (() => {
    if (source === undefined) {
      return undefined;
    }
    switch (source.kind) {
      case "existing":
        return {
          type: MATTER_FOLDER_DRAG_TYPE,
          kind: "existing",
          folderId: source.folderId,
          parentId: source.parentId,
          name: source.name,
        } as const satisfies MatterFolderDragData;
      case "pending":
        return {
          type: MATTER_FOLDER_DRAG_TYPE,
          kind: "pending",
          parentId: source.parentId,
          name: source.name,
        } as const satisfies MatterFolderDragData;
      default:
        return source satisfies never;
    }
  })();
  const moveDestinations =
    !isMoveMenuOpen || keyboardSourceData === undefined
      ? []
      : matterFolderMoveDestinations(
          folders,
          keyboardSourceData,
          t("workspaces.copyToMatter.rootFolder"),
        );
  const handleEnabled = sourceEnabled;

  useExternalSyncEffect(() => {
    const element = rowRef.current;
    if (!element) {
      return undefined;
    }

    const registrations = [];
    if (
      targetEnabled &&
      targetParentId !== undefined &&
      targetName !== undefined
    ) {
      registrations.push(
        dropTargetForElements({
          element,
          canDrop: ({ source: dragSource }) =>
            isMatterFolderDragData(dragSource.data) &&
            canDropMatterFolder(dragSource.data, folders, targetParentId),
          getData: () =>
            withDropAnnouncementData(
              { folderId: targetParentId },
              { type: "container", name: targetName },
            ),
          onDragEnter: () => setIsDropTarget(true),
          onDragLeave: () => setIsDropTarget(false),
          onDrop: ({ source: dragSource }) => {
            setIsDropTarget(false);
            if (
              !isMatterFolderDragData(dragSource.data) ||
              !canDropMatterFolder(dragSource.data, folders, targetParentId)
            ) {
              return;
            }
            handleMove(dragSource.data, targetParentId);
          },
        }),
      );
    }

    const dragHandle = dragHandleRef.current;
    if (
      handleEnabled &&
      sourceKind !== undefined &&
      sourceParentId !== undefined &&
      sourceName !== undefined &&
      dragHandle !== null
    ) {
      registrations.push(
        draggable({
          element,
          dragHandle,
          getInitialData: () =>
            withDragAnnouncementData(
              sourceKind === "existing"
                ? {
                    type: MATTER_FOLDER_DRAG_TYPE,
                    kind: "existing",
                    folderId: sourceFolderId,
                    parentId: sourceParentId,
                    name: sourceName,
                  }
                : {
                    type: MATTER_FOLDER_DRAG_TYPE,
                    kind: "pending",
                    parentId: sourceParentId,
                    name: sourceName,
                  },
              sourceName,
            ),
        }),
      );
    }

    if (registrations.length === 0) {
      return undefined;
    }
    return combine(...registrations);
  }, [
    folders,
    handleMove,
    handleEnabled,
    sourceFolderId,
    sourceKind,
    sourceName,
    sourceParentId,
    targetEnabled,
    targetName,
    targetParentId,
  ]);

  const dragHandle =
    source === undefined ? null : (
      <Menu onOpenChange={setIsMoveMenuOpen}>
        <MenuTrigger
          aria-label={t("workspaces.copyToMatter.moveFolder")}
          disabled={!handleEnabled}
          render={
            <button
              className={cn(
                "border-border/70 bg-background text-muted-foreground ms-auto flex size-6 shrink-0 touch-none items-center justify-center rounded border shadow-sm",
                handleEnabled
                  ? "hover:text-foreground cursor-grab active:cursor-grabbing"
                  : "cursor-not-allowed opacity-50",
              )}
              ref={dragHandleRef}
              type="button"
            />
          }
          tooltip={t("workspaces.copyToMatter.dragFolder")}
        >
          <GripVerticalIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="w-56">
          <MenuGroupLabel>
            {t("workspaces.copyToMatter.moveFolderTo")}
          </MenuGroupLabel>
          {keyboardSourceData === undefined
            ? null
            : moveDestinations.map((destination) => (
                <MenuItem
                  key={destination.parentId ?? "root"}
                  onClick={() =>
                    handleMove(keyboardSourceData, destination.parentId)
                  }
                >
                  <EntityKindIcon className="size-4 shrink-0" kind="folder" />
                  <BidiText as="span" className="truncate">
                    {destination.name}
                  </BidiText>
                </MenuItem>
              ))}
        </MenuPopup>
      </Menu>
    );

  return <div ref={rowRef}>{children({ isDropTarget, dragHandle })}</div>;
};

type FolderSelectionButtonProps = {
  name: string;
  selected: boolean;
  onSelect: () => void;
};

const FolderSelectionButton = ({
  name,
  selected,
  onSelect,
}: FolderSelectionButtonProps) => (
  <button
    className={cn(
      "hover:bg-accent flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-start text-sm",
      selected && "bg-accent",
    )}
    onClick={onSelect}
    type="button"
  >
    <EntityKindIcon className="size-4 shrink-0" kind="folder" />
    <BidiText as="span" className="truncate">
      {name}
    </BidiText>
  </button>
);

/**
 * Handles the case where the user types a new folder name in the picker. The
 * folder is created here, just before the caller's write (copy, move, save),
 * and the matter's folder tree is refreshed.
 *
 * Returns a `Result` whose value is a `ResolvedMatterTarget`:
 * - `workspaceId`: the chosen matter, unchanged from the input.
 * - `parentId`: the selected folder to write into. This is the newly created
 *   folder id when it remains selected, or the later existing selection.
 *   `null` means the matter root.
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
  const selectedMatter =
    value === null
      ? undefined
      : matters.find((workspace) => workspace.id === value.workspaceId);
  const orderedVisibleMatters =
    query === "" && selectedMatter !== undefined
      ? [
          selectedMatter,
          ...visibleMatters.filter(
            (workspace) => workspace.id !== selectedMatter.id,
          ),
        ]
      : visibleMatters;

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
        <ScrollArea
          className={cn(
            "border-border rounded-md border",
            showFolderPicker && value !== null ? "h-20" : "h-48",
          )}
        >
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
              return orderedVisibleMatters.map((workspace) => {
                const isSelected = value?.workspaceId === workspace.id;
                return (
                  <button
                    className={cn(
                      "hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm",
                      isSelected && "bg-accent",
                    )}
                    key={workspace.id}
                    onClick={() => {
                      if (value?.workspaceId === workspace.id) {
                        onChange(selectExistingMatterTarget(value, null));
                        return;
                      }
                      onChange({
                        type: "existing",
                        workspaceId: workspace.id,
                        parentId: null,
                      });
                    }}
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

type FolderDraft =
  | { type: "create"; name: string }
  | { type: "edit"; name: string };

const FolderPicker = ({ value, onChange }: FolderPickerProps) => {
  const t = useTranslations();
  const canCreate = usePermissions({ entity: ["create"] });
  const canMove = usePermissions({ entity: ["update"] });
  const queryClient = useQueryClient();
  const moveEntity = useMoveEntity();
  const workspaceId = value.workspaceId;
  const {
    data: folders,
    isLoading,
    isError,
  } = useQuery(workspaceFoldersOptions(workspaceId));

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  /** `null` while the new-folder row is a button or staged preview. */
  const [folderDraft, setFolderDraft] = useState<FolderDraft | null>(null);
  /** Set by Escape so the blur that follows unmounting does not stage the draft. */
  const draftCancelledRef = useRef(false);

  /** Reveal a destination and every ancestor that can otherwise hide it. */
  const expandFolderPath = (folderId: string | null) => {
    if (folders === undefined) {
      return;
    }
    const path = matterFolderPath(folders, folderId);
    if (path.length === 0) {
      return;
    }
    setExpandedFolders((previous) => new Set([...previous, ...path]));
  };

  const moveFolder = useLatestCallback(
    (source: MatterFolderDragData, targetParentId: string | null) => {
      switch (source.kind) {
        case "pending": {
          if (value.type !== "pending") {
            return;
          }
          onChange(reparentPendingMatterFolder(value, targetParentId));
          expandFolderPath(targetParentId);
          return;
        }
        case "existing": {
          if (
            folders === undefined ||
            !canMoveMatterFolder(folders, source.folderId, targetParentId)
          ) {
            return;
          }
          expandFolderPath(targetParentId);
          moveEntity.mutate(
            {
              workspaceId,
              entityId: source.folderId,
              parentId: targetParentId,
            },
            {
              onSuccess: () => {
                detached(
                  Promise.all([
                    queryClient.invalidateQueries({
                      queryKey: workspaceFoldersOptions(workspaceId).queryKey,
                    }),
                    queryClient.invalidateQueries({
                      queryKey: entitiesKeys.all(workspaceId),
                    }),
                  ]),
                  "matter-target-picker.invalidate-moved-folder",
                );
              },
              onError: () => {
                stellaToast.add({
                  title: t("errors.actionFailed"),
                  type: "error",
                });
              },
            },
          );
          return;
        }
      }
    },
  );

  if (isError) {
    return (
      <div className="border-border h-60 max-h-[35dvh] rounded-md border p-2">
        <p className="text-destructive text-sm">{t("errors.actionFailed")}</p>
      </div>
    );
  }

  if (isLoading || folders === undefined) {
    return (
      <div className="border-border h-60 max-h-[35dvh] rounded-md border p-2">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  const rootFolders = folders.filter((folder) => folder.parentId === null);
  const pendingFolder = value.type === "pending" ? value : null;
  const selectedExistingParentId = (() => {
    if (value.type === "existing") {
      return value.parentId;
    }
    if (value.selection.type === "existing") {
      return value.selection.parentId;
    }
    return undefined;
  })();

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
   * Stage a folder under whatever is selected now; it is created on submit.
   * Runs on Enter and on blur, so a name typed straight before clicking the
   * dialog's submit button is not dropped. An empty name closes the input.
   */
  const stageFolder = () => {
    if (folderDraft === null) {
      return;
    }
    const name = folderDraft.name.trim();
    if (name === "") {
      setFolderDraft(null);
      return;
    }
    switch (folderDraft.type) {
      case "create": {
        const staged = stageMatterFolder(value, name);
        if (staged === null) {
          return;
        }
        onChange(staged);
        expandFolderPath(staged.parentId);
        break;
      }
      case "edit": {
        if (pendingFolder === null) {
          return;
        }
        onChange({ ...pendingFolder, name });
        break;
      }
    }
    setFolderDraft(null);
  };

  /**
   * The folder about to be created: the draft input while its name is typed,
   * then the staged row. Both are the same thing at different moments, so one
   * node renders them and the preview cannot sit somewhere the folder will not.
   */
  const newFolderDraft = (() => {
    if (folderDraft !== null) {
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
          onChange={(e) =>
            setFolderDraft({ type: folderDraft.type, name: e.target.value })
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              stageFolder();
            }
            if (e.key === "Escape") {
              // Cancel only the draft; the enclosing dialog dismisses on Escape.
              e.stopPropagation();
              draftCancelledRef.current = true;
              setFolderDraft(null);
            }
          }}
          placeholder={t("workspaces.newFolder")}
          value={folderDraft.name}
        />
      );
    }
    return null;
  })();
  const hasNewFolderSlot = newFolderDraft !== null || pendingFolder !== null;

  /**
   * Called from the two positions that can hold the slot, both keyed off
   * `value.parentId`: the destination the folder will be created in.
   */
  const renderNewFolderSlot = (depth: number) => {
    if (newFolderDraft !== null) {
      return (
        <div
          className="flex items-center gap-1"
          style={{ paddingInlineStart: `${depth * 16 + 8}px` }}
        >
          <span className="w-4" />
          {newFolderDraft}
        </div>
      );
    }
    if (pendingFolder === null) {
      return null;
    }
    return (
      <FolderDragDropRow
        folders={folders}
        onMove={moveFolder}
        source={{
          kind: "pending",
          parentId: pendingFolder.parentId,
          name: pendingFolder.name,
        }}
        sourceEnabled={!moveEntity.isPending}
        targetEnabled={false}
      >
        {({ dragHandle }) => (
          <div
            className="flex items-center gap-1"
            style={{ paddingInlineStart: `${depth * 16 + 8}px` }}
          >
            <span className="w-4" />
            <FolderSelectionButton
              name={pendingFolder.name}
              onSelect={() =>
                onChange(selectPendingMatterTarget(pendingFolder))
              }
              selected={pendingFolder.selection.type === "pending"}
            />
            <Tooltip
              content={t("common.edit")}
              render={
                <button
                  aria-label={t("common.edit")}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded"
                  onClick={() => {
                    draftCancelledRef.current = false;
                    setFolderDraft({
                      type: "edit",
                      name: pendingFolder.name,
                    });
                  }}
                  type="button"
                />
              }
            >
              <PencilIcon className="size-3.5" />
            </Tooltip>
            <Tooltip
              content={t("common.remove")}
              render={
                <button
                  aria-label={t("common.remove")}
                  className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded"
                  onClick={() =>
                    onChange(discardPendingMatterFolder(pendingFolder))
                  }
                  type="button"
                />
              }
            >
              <XIcon className="size-3.5" />
            </Tooltip>
            {dragHandle}
          </div>
        )}
      </FolderDragDropRow>
    );
  };

  const newFolderButton =
    canCreate && folderDraft === null && pendingFolder === null ? (
      <button
        className="hover:bg-accent text-muted-foreground flex w-full items-center gap-1 rounded px-2 py-1 text-start text-sm"
        onClick={() => {
          draftCancelledRef.current = false;
          setFolderDraft({ type: "create", name: "" });
          expandFolderPath(value.parentId);
        }}
        type="button"
      >
        <FolderPlusIcon className="size-4 shrink-0" />
        <span className="truncate">{t("workspaces.newFolder")}</span>
      </button>
    ) : null;

  const renderFolder = (folder: WorkspaceFolder, depth: number) => {
    const children = folders.filter(
      (child) => child.parentId === folder.entityId,
    );
    const hasNestedNewFolderSlot =
      hasNewFolderSlot && value.parentId === folder.entityId;
    const hasChildren = children.length > 0 || hasNestedNewFolderSlot;
    const isExpanded = expandedFolders.has(folder.entityId);
    const isSelected = selectedExistingParentId === folder.entityId;

    return (
      <div key={folder.entityId}>
        <FolderDragDropRow
          folders={folders}
          onMove={moveFolder}
          source={{
            kind: "existing",
            folderId: folder.entityId,
            parentId: folder.parentId,
            name: folder.name,
          }}
          sourceEnabled={canMove && !moveEntity.isPending}
          target={{ parentId: folder.entityId, name: folder.name }}
          targetEnabled={
            (canMove || pendingFolder !== null) && !moveEntity.isPending
          }
        >
          {({ isDropTarget, dragHandle }) => (
            <div
              className={cn(
                "flex items-center gap-1 rounded",
                isDropTarget && "bg-primary/8 ring-primary/40 ring-1",
              )}
              style={{ paddingInlineStart: `${depth * 16 + 8}px` }}
            >
              {hasChildren ? (
                <Tooltip
                  content={
                    isExpanded
                      ? t("workspaces.importOrganizer.collapseFolder")
                      : t("workspaces.importOrganizer.expandFolder")
                  }
                  render={
                    <button
                      className="hover:bg-muted rounded p-0.5"
                      aria-expanded={isExpanded}
                      aria-label={
                        isExpanded
                          ? t("workspaces.importOrganizer.collapseFolder")
                          : t("workspaces.importOrganizer.expandFolder")
                      }
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
              <FolderSelectionButton
                name={folder.name}
                onSelect={() =>
                  onChange(selectExistingMatterTarget(value, folder.entityId))
                }
                selected={isSelected}
              />
              {dragHandle}
            </div>
          )}
        </FolderDragDropRow>
        {hasChildren && isExpanded && (
          <div>
            {children.map((child) => renderFolder(child, depth + 1))}
            {hasNestedNewFolderSlot && renderNewFolderSlot(depth + 1)}
          </div>
        )}
      </div>
    );
  };

  return (
    <ScrollArea className="border-border h-60 max-h-[35dvh] rounded-md border">
      <div className="p-1">
        <FolderDragDropRow
          folders={folders}
          onMove={moveFolder}
          sourceEnabled={false}
          target={{
            parentId: null,
            name: t("workspaces.copyToMatter.rootFolder"),
          }}
          targetEnabled={
            (canMove || pendingFolder !== null) && !moveEntity.isPending
          }
        >
          {({ isDropTarget }) => (
            <button
              className={cn(
                "hover:bg-accent flex w-full items-center gap-1 rounded px-2 py-1 text-start text-sm",
                selectedExistingParentId === null && "bg-accent",
                isDropTarget && "bg-primary/8 ring-primary/40 ring-1",
              )}
              onClick={() => onChange(selectExistingMatterTarget(value, null))}
              type="button"
            >
              <span className="text-muted-foreground">
                {t("workspaces.copyToMatter.rootFolder")}
              </span>
            </button>
          )}
        </FolderDragDropRow>
        {rootFolders.map((folder) => renderFolder(folder, 0))}
        {value.parentId === null && renderNewFolderSlot(0)}
        {newFolderButton}
      </div>
    </ScrollArea>
  );
};
