import { useEffect, useRef, useState } from "react";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  CopyIcon,
  EllipsisVerticalIcon,
  FolderTreeIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  PencilIcon,
  PlusIcon,
  TableIcon,
  Trash2Icon,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslations } from "use-intl";

import type { ViewLayout, ViewLayoutType } from "@stella/api/types";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stella/ui/components/alert-dialog";
import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stella/ui/components/menu";
import { Tabs, TabsList, TabsTab } from "@stella/ui/components/tabs";
import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

import { usePermissions } from "@/hooks/use-permissions";
import type { TranslationKey } from "@/i18n/types";
import type { WorkspaceView } from "@/lib/types";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import {
  useConvertView,
  useCreateView,
  useDeleteView,
  useReorderViews,
  useUpdateView,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

const VIEW_DRAG_TYPE = "stella/view-id";

const REQUIRED_VIEW_LAYOUTS: ViewLayoutType[] = [
  "overview",
  "table",
  "filesystem",
];

const layoutIcons: Record<ViewLayoutType, React.ElementType> = {
  overview: LayoutDashboardIcon,
  table: TableIcon,
  filesystem: FolderTreeIcon,
  kanban: KanbanIcon,
};

const LAYOUT_LABEL_KEYS = {
  overview: "workspaces.views.layouts.overview",
  table: "workspaces.views.layouts.table",
  filesystem: "workspaces.views.layouts.list",
  kanban: "workspaces.views.layouts.kanban",
} as const satisfies Record<ViewLayoutType, TranslationKey>;

const emptyLayout = (type: ViewLayoutType): ViewLayout => {
  const base = {
    filters: [],
    sorts: [],
    hiddenProperties: [],
  };

  if (type === "table") {
    return { type, ...base, columnOrder: [], columnPinning: [] };
  }

  return { type, ...base };
};

const defaultLayouts: Record<ViewLayoutType, ViewLayout> = {
  overview: emptyLayout("overview"),
  table: emptyLayout("table"),
  filesystem: emptyLayout("filesystem"),
  kanban: emptyLayout("kanban"),
};

const LAYOUT_OPTIONS: ViewLayoutType[] = [
  "overview",
  "table",
  "filesystem",
  "kanban",
];

type ViewSwitcherProps = {
  workspaceId: string;
  activeViewId: string;
  onViewChange: (viewId: string) => void;
};

export const ViewSwitcher = ({
  workspaceId,
  activeViewId,
  onViewChange,
}: ViewSwitcherProps) => {
  const t = useTranslations();
  const canCreateView = usePermissions({ view: ["create"] });
  const queryClient = useQueryClient();
  const { data: views } = useSuspenseQuery(
    viewsOptions(workspaceId, queryClient),
  );
  const createView = useCreateView(workspaceId);
  const reorderViews = useReorderViews(workspaceId);

  const handleReorder = (draggedId: string, targetId: string) => {
    const ids = views.map((v) => v.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);

    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) {
      return;
    }

    const reordered = ids.toSpliced(fromIdx, 1);
    reordered.splice(toIdx, 0, draggedId);

    reorderViews.mutate(
      { viewIds: reordered },
      {
        onError: () => {
          toastManager.add({
            title: t("errors.failedToReorderViews"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <div className="flex items-center gap-1 px-2">
      <Tabs value={activeViewId}>
        <TabsList variant="underline">
          {views.map((view) => {
            const isLastOfLayout =
              REQUIRED_VIEW_LAYOUTS.includes(view.layout.type) &&
              views.filter((v) => v.layout.type === view.layout.type).length <=
                1;

            return (
              <ViewTab
                activeViewId={activeViewId}
                canDelete={!isLastOfLayout}
                key={view.id}
                onReorder={handleReorder}
                onSelect={() => onViewChange(view.id)}
                view={view}
                workspaceId={workspaceId}
              />
            );
          })}
        </TabsList>
      </Tabs>
      {canCreateView && (
        <Menu>
          <MenuTrigger
            render={
              <Button
                disabled={createView.isPending}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <PlusIcon />
          </MenuTrigger>
          <MenuPopup>
            {LAYOUT_OPTIONS.map((layoutType) => {
              const Icon = layoutIcons[layoutType];
              return (
                <MenuItem
                  key={layoutType}
                  onClick={() => {
                    const viewId = nanoid();
                    createView.mutate(
                      {
                        id: viewId,
                        name: t("workspaces.views.newView", {
                          layout: t(LAYOUT_LABEL_KEYS[layoutType]),
                        }),
                        layout: defaultLayouts[layoutType],
                      },
                      {
                        onSuccess: () => {
                          onViewChange(viewId);
                        },
                        onError: () => {
                          toastManager.add({
                            title: t("errors.failedToCreateView"),
                            type: "error",
                          });
                        },
                      },
                    );
                  }}
                >
                  <Icon />
                  {t(LAYOUT_LABEL_KEYS[layoutType])}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
};

type ViewTabProps = {
  workspaceId: string;
  activeViewId: string;
  view: WorkspaceView;
  canDelete: boolean;
  onSelect: () => void;
  onReorder: (draggedId: string, targetId: string) => void;
};

const ViewTab = ({
  workspaceId,
  activeViewId,
  view,
  canDelete,
  onSelect,
  onReorder,
}: ViewTabProps) => {
  const { id, name, layout } = view;
  const isActive = id === activeViewId;
  const t = useTranslations();
  const canCreateView = usePermissions({ view: ["create"] });
  const canUpdateView = usePermissions({ view: ["update"] });
  const canDeleteView = usePermissions({ view: ["delete"] });
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(name);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const updateView = useUpdateView(workspaceId);
  const containerRef = useRef<HTMLDivElement>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    return combine(
      ...(canUpdateView
        ? [
            draggable({
              element: el,
              getInitialData: () => ({
                type: VIEW_DRAG_TYPE,
                viewId: id,
              }),
            }),
          ]
        : []),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          source.data.type === VIEW_DRAG_TYPE && source.data.viewId !== id,
        onDragEnter: () => setIsDropTarget(true),
        onDragLeave: () => setIsDropTarget(false),
        onDrop: ({ source }) => {
          setIsDropTarget(false);
          onReorderRef.current(source.data.viewId as string, id);
        },
      }),
    );
  }, [id, canUpdateView]);

  const handleRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed === name) {
      setIsRenaming(false);
      setRenameValue(name);
      return;
    }

    updateView.mutate(
      { viewId: id, name: trimmed },
      {
        onSuccess: () => setIsRenaming(false),
        onError: () => {
          toastManager.add({
            title: t("errors.failedToRenameView"),
            type: "error",
          });
          setIsRenaming(false);
          setRenameValue(name);
        },
      },
    );
  };

  const Icon = layoutIcons[layout.type];

  if (isRenaming) {
    return (
      <TabsTab nativeButton={false} render={<div />} value={id}>
        <Icon className="size-3.5" />
        <InlineEdit
          inputClassName="w-24"
          onCancel={() => {
            setIsRenaming(false);
            setRenameValue(name);
          }}
          onChange={setRenameValue}
          onCommit={handleRename}
          value={renameValue}
        />
      </TabsTab>
    );
  }

  return (
    <div
      className={cn("relative", isDropTarget && "rounded ring-2 ring-primary")}
      ref={containerRef}
    >
      <TabsTab
        className={cn(isActive && "pr-6.5")}
        onClick={onSelect}
        onDoubleClick={(e) => {
          if (!canUpdateView) {
            return;
          }
          e.preventDefault();
          setIsRenaming(true);
          setRenameValue(name);
        }}
        value={id}
      >
        <Icon className="size-3.5" />
        {name}
      </TabsTab>
      {isActive && (canUpdateView || canCreateView || canDeleteView) && (
        <ViewTabMenu
          canDelete={canDelete}
          className="absolute top-1/2 right-0 -translate-y-1/2"
          onRename={() => {
            setIsRenaming(true);
            setRenameValue(name);
          }}
          view={view}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
};

type ViewTabMenuProps = {
  workspaceId: string;
  view: WorkspaceView;
  canDelete: boolean;
  onRename: () => void;
  className: string;
};

const ViewTabMenu = ({
  workspaceId,
  view,
  canDelete,
  onRename,
  className,
}: ViewTabMenuProps) => {
  const { id, name, layout } = view;
  const t = useTranslations();
  const canCreateView = usePermissions({ view: ["create"] });
  const canUpdateView = usePermissions({ view: ["update"] });
  const canDeleteView = usePermissions({ view: ["delete"] });
  const createView = useCreateView(workspaceId);
  const convertView = useConvertView(workspaceId);
  const deleteView = useDeleteView(workspaceId);

  const Icon = layoutIcons[layout.type];

  const handleDuplicate = () => {
    const id = nanoid();
    createView.mutate(
      {
        id,
        name: t("workspaces.views.copySuffix", {
          name: view.name,
        }),
        layout: view.layout,
      },
      {
        onError: () => {
          toastManager.add({
            title: t("errors.failedToDuplicateView"),
            type: "error",
          });
        },
      },
    );
  };

  const handleDelete = () => {
    deleteView.mutate(
      { viewId: id },
      {
        onError: () => {
          toastManager.add({
            title: t("errors.failedToDeleteView"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <Menu>
      <MenuTrigger
        render={<Button className={className} size="icon-xs" variant="ghost" />}
      >
        <EllipsisVerticalIcon />
      </MenuTrigger>
      <MenuPopup>
        {canUpdateView && (
          <MenuItem onClick={onRename}>
            <PencilIcon />
            {t("common.rename")}
          </MenuItem>
        )}
        {canCreateView && (
          <MenuItem onClick={handleDuplicate}>
            <CopyIcon />
            {t("common.duplicate")}
          </MenuItem>
        )}
        {canUpdateView && (
          <MenuSub>
            <MenuSubTrigger>
              <Icon />
              {t("common.convertTo")}
            </MenuSubTrigger>
            <MenuSubPopup>
              {LAYOUT_OPTIONS.filter((l) => l !== layout.type).map((l) => {
                const LayoutIcon = layoutIcons[l];
                return (
                  <MenuItem
                    key={l}
                    onClick={() => {
                      convertView.mutate(
                        {
                          viewId: id,
                          targetType: l,
                        },
                        {
                          onError: () => {
                            toastManager.add({
                              title: t("errors.failedToChangeViewType"),
                              type: "error",
                            });
                          },
                        },
                      );
                    }}
                  >
                    <LayoutIcon />
                    {t(LAYOUT_LABEL_KEYS[l])}
                  </MenuItem>
                );
              })}
            </MenuSubPopup>
          </MenuSub>
        )}
        {(canUpdateView || canCreateView) && canDeleteView && <MenuSeparator />}
        {canDeleteView && (
          <AlertDialog>
            <AlertDialogTrigger
              disabled={!canDelete}
              nativeButton={false}
              render={<MenuItem closeOnClick={false} variant="destructive" />}
            >
              <Trash2Icon />
              {t("common.delete")}
            </AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("workspaces.views.deleteView")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("common.deleteConfirmDescription", {
                    name,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="ghost" />}>
                  {t("common.cancel")}
                </AlertDialogClose>
                <AlertDialogClose
                  render={
                    <Button onClick={handleDelete} variant="destructive" />
                  }
                >
                  {t("common.delete")}
                </AlertDialogClose>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}
      </MenuPopup>
    </Menu>
  );
};
