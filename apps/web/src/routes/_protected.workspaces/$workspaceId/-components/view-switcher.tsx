import { useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  CopyIcon,
  EllipsisVerticalIcon,
  FolderTreeIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  LayoutGridIcon,
  PencilIcon,
  PlusIcon,
  TableIcon,
  Trash2Icon,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useDrag, useDrop } from "react-aria";
import { useTranslations } from "use-intl";

import type { ViewConfig, ViewLayout } from "@stella/api/types";
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

import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import {
  useCreateView,
  useDeleteView,
  useReorderViews,
  useUpdateView,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

const VIEW_DRAG_TYPE = "stella/view-id";

const REQUIRED_VIEW_LAYOUTS: ReadonlySet<ViewLayout> = new Set([
  "overview",
  "table",
  "filesystem",
]);

const layoutIcons: Record<ViewLayout, typeof TableIcon> = {
  overview: LayoutDashboardIcon,
  table: TableIcon,
  filesystem: FolderTreeIcon,
  gallery: LayoutGridIcon,
  kanban: KanbanIcon,
};

const LAYOUT_LABEL_KEYS = {
  overview: "workspaces.views.layouts.overview",
  table: "workspaces.views.layouts.table",
  filesystem: "workspaces.views.layouts.list",
  gallery: "workspaces.views.layouts.grid",
  kanban: "workspaces.views.layouts.kanban",
} as const satisfies Record<ViewLayout, string>;

const defaultConfig: ViewConfig = {
  filters: [],
  sorts: [],
  visibleProperties: [],
  columnSizing: {},
  columnOrder: [],
};

const defaultConfigs: Record<ViewLayout, ViewConfig> = {
  overview: defaultConfig,
  table: defaultConfig,
  filesystem: defaultConfig,
  gallery: defaultConfig,
  kanban: defaultConfig,
};

type ViewSwitcherProps = {
  workspaceId: string;
  activeViewId: string | null;
  onViewChange: (viewId: string) => void;
};

const LAYOUT_OPTIONS = ["overview", "table", "filesystem", "kanban"] as const;

export const ViewSwitcher = ({
  workspaceId,
  activeViewId,
  onViewChange,
}: ViewSwitcherProps) => {
  const t = useTranslations();
  const { data: views } = useSuspenseQuery(viewsOptions(workspaceId));
  const createView = useCreateView();
  const reorderViews = useReorderViews();

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
      { workspaceId, viewIds: reordered },
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

  const currentViewId = activeViewId ?? views[0]?.id ?? null;

  return (
    <div className="flex items-center gap-1 px-2">
      <Tabs value={currentViewId}>
        <TabsList variant="underline">
          {views.map((view) => {
            const Icon = layoutIcons[view.layout];
            const isLastOfLayout =
              REQUIRED_VIEW_LAYOUTS.has(view.layout) &&
              views.filter((v) => v.layout === view.layout).length <= 1;

            return (
              <ViewTab
                config={view.config}
                deleteDisabled={isLastOfLayout}
                icon={<Icon className="size-3.5" />}
                isActive={view.id === currentViewId}
                key={view.id}
                layout={view.layout}
                name={view.name}
                onDuplicate={() => {
                  const id = nanoid();
                  createView.mutate(
                    {
                      workspaceId,
                      id,
                      name: t("workspaces.views.copySuffix", {
                        name: view.name,
                      }),
                      layout: view.layout,
                      config: view.config,
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
                }}
                onReorder={handleReorder}
                onSelect={() => onViewChange(view.id)}
                viewId={view.id}
                workspaceId={workspaceId}
              />
            );
          })}
        </TabsList>
      </Tabs>
      <Menu>
        <MenuTrigger
          render={
            <Button
              className="size-7"
              disabled={createView.isPending}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <PlusIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup>
          {LAYOUT_OPTIONS.map((layout) => {
            const Icon = layoutIcons[layout];
            return (
              <MenuItem
                key={layout}
                onClick={() => {
                  const viewId = nanoid();
                  createView.mutate(
                    {
                      workspaceId,
                      id: viewId,
                      name: t("workspaces.views.newView", {
                        layout: t(LAYOUT_LABEL_KEYS[layout]),
                      }),
                      layout,
                      config: defaultConfigs[layout],
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
                <Icon className="size-4" />
                {t(LAYOUT_LABEL_KEYS[layout])}
              </MenuItem>
            );
          })}
        </MenuPopup>
      </Menu>
    </div>
  );
};

type ViewTabProps = {
  viewId: string;
  workspaceId: string;
  name: string;
  layout: ViewLayout;
  config: ViewConfig;
  icon: React.ReactNode;
  isActive: boolean;
  deleteDisabled: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
  onReorder: (draggedId: string, targetId: string) => void;
};

const ViewTab = ({
  viewId,
  workspaceId,
  name,
  layout,
  config,
  icon,
  isActive,
  deleteDisabled,
  onSelect,
  onDuplicate,
  onReorder,
}: ViewTabProps) => {
  const t = useTranslations();
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(name);
  const updateView = useUpdateView();
  const deleteView = useDeleteView();
  const dropRef = useRef<HTMLDivElement>(null);

  const { dragProps } = useDrag({
    getItems: () => [{ [VIEW_DRAG_TYPE]: viewId }],
  });

  const { dropProps, isDropTarget } = useDrop({
    ref: dropRef,
    async onDrop(e) {
      for (const item of e.items) {
        if (item.kind === "text" && item.types.has(VIEW_DRAG_TYPE)) {
          const draggedId = await item.getText(VIEW_DRAG_TYPE);
          if (draggedId !== viewId) {
            onReorder(draggedId, viewId);
          }
        }
      }
    },
  });

  const handleRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed === name) {
      setIsRenaming(false);
      setRenameValue(name);
      return;
    }

    updateView.mutate(
      { workspaceId, viewId, name: trimmed, layout },
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

  const handleDelete = () => {
    deleteView.mutate(
      { workspaceId, viewId },
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

  if (isRenaming) {
    return (
      <TabsTab value={viewId}>
        {icon}
        <InlineEdit
          inputClassName="w-24"
          onChange={setRenameValue}
          onCancel={() => {
            setIsRenaming(false);
            setRenameValue(name);
          }}
          onCommit={handleRename}
          value={renameValue}
        />
      </TabsTab>
    );
  }

  return (
    <div
      className={cn(isDropTarget && "rounded ring-2 ring-primary")}
      ref={dropRef}
      {...dragProps}
      {...dropProps}
    >
      <TabsTab
        onClick={onSelect}
        onDoubleClick={(e) => {
          e.preventDefault();
          setIsRenaming(true);
          setRenameValue(name);
        }}
        value={viewId}
      >
        <span className="flex items-center gap-1">
          {icon}
          <span>{name}</span>
        </span>
        {isActive && (
          <Menu>
            <MenuTrigger
              onClick={(e) => e.stopPropagation()}
              render={
                // biome-ignore lint/a11y/useSemanticElements: nested inside a button
                <span
                  className="inline-flex size-5 items-center justify-center rounded opacity-60 hover:bg-accent hover:opacity-100"
                  role="button"
                  tabIndex={0}
                />
              }
            >
              <EllipsisVerticalIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup>
              <MenuItem
                onClick={() => {
                  setIsRenaming(true);
                  setRenameValue(name);
                }}
              >
                <PencilIcon className="size-4" />
                {t("common.rename")}
              </MenuItem>
              <MenuItem onClick={onDuplicate}>
                <CopyIcon className="size-4" />
                {t("common.duplicate")}
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger>
                  {icon}
                  {t("common.convertTo")}
                </MenuSubTrigger>
                <MenuSubPopup>
                  {LAYOUT_OPTIONS.filter((l) => l !== layout).map((l) => {
                    const Icon = layoutIcons[l];
                    return (
                      <MenuItem
                        key={l}
                        onClick={() => {
                          updateView.mutate(
                            {
                              workspaceId,
                              viewId,
                              layout: l,
                              config,
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
                        <Icon className="size-4" />
                        {t(LAYOUT_LABEL_KEYS[l])}
                      </MenuItem>
                    );
                  })}
                </MenuSubPopup>
              </MenuSub>
              <MenuSeparator />
              {deleteDisabled ? (
                <MenuItem
                  onClick={() => {
                    toastManager.add({
                      title: t("workspaces.views.cannotDeleteRequired"),
                      type: "info",
                    });
                  }}
                >
                  <Trash2Icon className="size-4 opacity-50" />
                  <span className="opacity-50">{t("common.delete")}</span>
                </MenuItem>
              ) : (
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <MenuItem closeOnClick={false} variant="destructive" />
                    }
                  >
                    <Trash2Icon className="size-4" />
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
                          <Button
                            onClick={handleDelete}
                            variant="destructive"
                          />
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
        )}
      </TabsTab>
    </div>
  );
};
