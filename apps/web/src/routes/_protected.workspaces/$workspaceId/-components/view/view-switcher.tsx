import { useRef, useState } from "react";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { useQuery } from "@tanstack/react-query";
import {
  BookmarkIcon,
  BookmarkPlusIcon,
  CalendarIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  FolderTreeIcon,
  GanttChartIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  PencilIcon,
  PlusIcon,
  TableIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { ViewLayout, ViewLayoutType } from "@stll/api/types";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { MenuPreviewLayout } from "@stll/ui/components/preview-pane";
import { Tabs, TabsList, TabsTab } from "@stll/ui/components/tabs";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useAnchoredMenu } from "@/components/inspector/use-anchored-menu";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import type { TranslationKey } from "@/i18n/types";
import type { WorkspaceView } from "@/lib/types";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { SaveAsTemplateDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/view/save-as-template-dialog";
import { TemplatePickerDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/view/template-picker-dialog";
import type { ViewLayoutPreviewKind } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-layout-preview";
import { ViewLayoutPreview } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-layout-preview";
import {
  useConvertView,
  useCreateView,
  useDeleteView,
  useReorderViews,
  useUpdateView,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";

const VIEW_DRAG_TYPE = "stella/view-id";

const REQUIRED_VIEW_LAYOUTS: readonly ViewLayoutType[] = Object.freeze([
  "overview",
  "table",
  "filesystem",
  "kanban",
]);

const layoutIcons = {
  overview: LayoutDashboardIcon,
  table: TableIcon,
  filesystem: FolderTreeIcon,
  kanban: KanbanIcon,
  calendar: CalendarIcon,
  timeline: GanttChartIcon,
} as const satisfies Record<ViewLayoutType, React.ElementType>;

const LAYOUT_LABEL_KEYS = {
  overview: "workspaces.views.layouts.overview",
  table: "workspaces.views.layouts.table",
  filesystem: "workspaces.views.layouts.list",
  kanban: "workspaces.views.layouts.kanban",
  calendar: "workspaces.views.layouts.calendar",
  timeline: "workspaces.views.layouts.timeline",
} as const satisfies Record<ViewLayoutType, TranslationKey>;

const emptyLayout = (
  type: "overview" | "table" | "filesystem" | "kanban",
): ViewLayout => {
  const base = {
    filters: [],
    sorts: [],
    hiddenProperties: [],
  };

  if (type === "table") {
    return {
      version: 1,
      type,
      ...base,
      columnOrder: [],
      columnPinning: [],
    };
  }

  return { version: 1, type, ...base };
};

const defaultLayouts = {
  overview: emptyLayout("overview"),
  table: emptyLayout("table"),
  filesystem: emptyLayout("filesystem"),
  kanban: emptyLayout("kanban"),
  calendar: {
    version: 1,
    type: "calendar",
    filters: [],
    sorts: [],
    hiddenProperties: [],
    datePropertyId: "_start-date",
    mode: "month",
  },
  timeline: {
    version: 1,
    type: "timeline",
    filters: [],
    sorts: [],
    hiddenProperties: [],
    startDatePropertyId: "_created-at",
    endDatePropertyId: "_created-at",
    zoom: "month",
    showTable: false,
  },
} as const satisfies Record<ViewLayoutType, ViewLayout>;

const LAYOUT_OPTIONS: ViewLayoutType[] = [
  "overview",
  "table",
  "filesystem",
  "kanban",
  "calendar",
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
  const { data: views = [] } = useQuery(viewsOptions(workspaceId));
  const createView = useCreateView(workspaceId);
  const reorderViews = useReorderViews(workspaceId);
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null);
  const viewActions = useViewActionsMenu({
    workspaceId,
    onRenameView: setRenamingViewId,
  });
  const [isTemplatePickerOpen, setIsTemplatePickerOpen] = useState(false);
  const hasOverviewView = views.some((view) => view.layout.type === "overview");
  const createLayoutOptions = hasOverviewView
    ? LAYOUT_OPTIONS.filter((layoutType) => layoutType !== "overview")
    : LAYOUT_OPTIONS;
  const defaultPreviewKind = createLayoutOptions[0] ?? "table";
  const [previewKind, setPreviewKind] = useState<ViewLayoutPreviewKind | null>(
    defaultPreviewKind,
  );
  const disallowedTemplateLayouts = new Set<ViewLayoutType>(
    hasOverviewView ? ["overview"] : [],
  );

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
          stellaToast.add({
            title: t("errors.failedToReorderViews"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-1 overflow-x-auto px-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
      <Tabs value={activeViewId}>
        <TabsList variant="underline">
          {views.map((view) => {
            const isLastOfLayout =
              REQUIRED_VIEW_LAYOUTS.includes(view.layout.type) &&
              views.filter((v) => v.layout.type === view.layout.type).length <=
                1;

            return (
              <ViewTab
                actions={
                  view.id === activeViewId
                    ? viewActions.renderActions({
                        view,
                        canDelete: !isLastOfLayout,
                      })
                    : null
                }
                isRenaming={renamingViewId === view.id}
                key={view.id}
                onOpenContextMenu={(event) =>
                  viewActions.openFor({
                    view,
                    canDelete: !isLastOfLayout,
                    event,
                  })
                }
                onReorder={handleReorder}
                onSelect={() => onViewChange(view.id)}
                onStartRename={() => setRenamingViewId(view.id)}
                onStopRename={() =>
                  setRenamingViewId((current) =>
                    current === view.id ? null : current,
                  )
                }
                view={view}
                workspaceId={workspaceId}
              />
            );
          })}
        </TabsList>
      </Tabs>
      {canCreateView && (
        <Menu
          onOpenChange={() => {
            setPreviewKind(defaultPreviewKind);
          }}
        >
          <MenuTrigger
            aria-label={t("common.add")}
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
            <MenuPreviewLayout
              preview={
                <ViewLayoutPreview
                  kind={previewKind}
                  workspaceId={workspaceId}
                />
              }
            >
              {createLayoutOptions.map((layoutType) => {
                const Icon = layoutIcons[layoutType];
                return (
                  <MenuItem
                    key={layoutType}
                    onClick={() => {
                      const viewId = crypto.randomUUID();
                      createView.mutate(
                        {
                          id: viewId,
                          // `layoutType` lets each locale inflect "New {layout}"
                          // for the layout noun's gender (ICU select); the name
                          // stays distinct from the default-view-name set.
                          name: t("workspaces.views.newView", {
                            layout: t(LAYOUT_LABEL_KEYS[layoutType]),
                            layoutType,
                          }),
                          layout: defaultLayouts[layoutType],
                        },
                        {
                          onSuccess: () => {
                            onViewChange(viewId);
                          },
                          onError: () => {
                            stellaToast.add({
                              title: t("errors.failedToCreateView"),
                              type: "error",
                            });
                          },
                        },
                      );
                    }}
                    onFocus={() => setPreviewKind(layoutType)}
                    onMouseEnter={() => setPreviewKind(layoutType)}
                  >
                    <Icon />
                    {t(LAYOUT_LABEL_KEYS[layoutType])}
                  </MenuItem>
                );
              })}
              <MenuSeparator />
              <MenuItem
                onClick={() => setIsTemplatePickerOpen(true)}
                onFocus={() => setPreviewKind("template")}
                onMouseEnter={() => setPreviewKind("template")}
              >
                <BookmarkIcon />
                {t("workspaces.views.useTemplate")}
              </MenuItem>
            </MenuPreviewLayout>
          </MenuPopup>
        </Menu>
      )}
      {canCreateView && (
        <TemplatePickerDialog
          disallowedLayoutTypes={disallowedTemplateLayouts}
          onCreated={onViewChange}
          onOpenChange={setIsTemplatePickerOpen}
          open={isTemplatePickerOpen}
          workspaceId={workspaceId}
        />
      )}
      {viewActions.overlays}
    </div>
  );
};

type ViewTabProps = {
  workspaceId: string;
  view: WorkspaceView;
  isRenaming: boolean;
  actions: React.ReactNode;
  onSelect: () => void;
  onReorder: (draggedId: string, targetId: string) => void;
  onStartRename: () => void;
  onStopRename: () => void;
  onOpenContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
};

const ViewTab = ({
  workspaceId,
  view,
  isRenaming,
  actions,
  onSelect,
  onReorder,
  onStartRename,
  onStopRename,
  onOpenContextMenu,
}: ViewTabProps) => {
  const { id, name, layout } = view;
  const t = useTranslations();
  const canUpdateView = usePermissions({ view: ["update"] });
  const [renameValue, setRenameValue] = useState(name);
  const [wasRenaming, setWasRenaming] = useState(isRenaming);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const updateView = useUpdateView(workspaceId);
  const containerRef = useRef<HTMLDivElement>(null);
  const handleReorder = useLatestCallback(onReorder);

  // Seed the draft from the current name each time rename begins,
  // since the trigger now lives in the parent (menu or double-click).
  if (isRenaming !== wasRenaming) {
    setWasRenaming(isRenaming);
    if (isRenaming) {
      setRenameValue(name);
    }
  }

  useExternalSyncEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return undefined;
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
          source.data["type"] === VIEW_DRAG_TYPE &&
          source.data["viewId"] !== id,
        onDragEnter: () => setIsDropTarget(true),
        onDragLeave: () => setIsDropTarget(false),
        onDrop: ({ source }) => {
          setIsDropTarget(false);
          const draggedViewId = source.data["viewId"];
          if (typeof draggedViewId !== "string") {
            return;
          }
          handleReorder(draggedViewId, id);
        },
      }),
    );
  }, [id, canUpdateView, handleReorder]);

  const handleRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed === name) {
      onStopRename();
      setRenameValue(name);
      return;
    }

    updateView.mutate(
      { viewId: id, name: trimmed },
      {
        onSuccess: () => onStopRename(),
        onError: () => {
          stellaToast.add({
            title: t("errors.failedToRenameView"),
            type: "error",
          });
          onStopRename();
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
            onStopRename();
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
      className={cn("relative", isDropTarget && "ring-primary rounded ring-2")}
      ref={containerRef}
    >
      <TabsTab
        className="pe-6.5"
        onClick={onSelect}
        onContextMenu={onOpenContextMenu}
        onDoubleClick={(e) => {
          if (!canUpdateView) {
            return;
          }
          e.preventDefault();
          onStartRename();
        }}
        value={id}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="max-w-36 truncate">{name}</span>
      </TabsTab>
      {actions}
    </div>
  );
};

type UseViewActionsMenuOptions = {
  workspaceId: string;
  onRenameView: (viewId: string) => void;
};

type ViewActionsTarget = {
  view: WorkspaceView;
  canDelete: boolean;
};

type OpenViewActionsArgs = ViewActionsTarget & {
  event: React.MouseEvent<HTMLElement>;
};

/**
 * Single, shared view-actions menu for the whole switcher. One
 * instance owns the mutations, dialogs, and cursor-anchored menu;
 * `openFor` retargets it at the right-clicked (or three-dot) view,
 * so per-tab mounting of mutations and dialogs is avoided.
 */
const useViewActionsMenu = ({
  workspaceId,
  onRenameView,
}: UseViewActionsMenuOptions) => {
  const t = useTranslations();
  const canCreateView = usePermissions({ view: ["create"] });
  const canUpdateView = usePermissions({ view: ["update"] });
  const canDeleteView = usePermissions({ view: ["delete"] });
  const createView = useCreateView(workspaceId);
  const convertView = useConvertView(workspaceId);
  const deleteView = useDeleteView(workspaceId);
  const [target, setTarget] = useState<ViewActionsTarget | null>(null);
  const [isSaveTemplateOpen, setIsSaveTemplateOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [convertPreview, setConvertPreview] = useState<ViewLayoutType | null>(
    null,
  );

  const hasActions = canUpdateView || canCreateView || canDeleteView;

  const handleDuplicate = (view: WorkspaceView) => {
    const newId = crypto.randomUUID();
    createView.mutate(
      {
        id: newId,
        name: t("workspaces.views.copySuffix", {
          name: view.name,
        }),
        layout: view.layout,
      },
      {
        onError: () => {
          stellaToast.add({
            title: t("errors.failedToDuplicateView"),
            type: "error",
          });
        },
      },
    );
  };

  const handleDelete = (viewId: string) => {
    deleteView.mutate(
      { viewId },
      {
        onError: () => {
          stellaToast.add({
            title: t("errors.failedToDeleteView"),
            type: "error",
          });
        },
      },
    );
  };

  const renderItems = ({ view, canDelete }: ViewActionsTarget) => {
    const { id, layout } = view;
    const Icon = layoutIcons[layout.type];
    return (
      <>
        {canUpdateView && (
          <MenuItem onClick={() => onRenameView(id)}>
            <PencilIcon />
            {t("common.rename")}
          </MenuItem>
        )}
        {canCreateView && layout.type !== "overview" && (
          <MenuItem onClick={() => handleDuplicate(view)}>
            <CopyIcon />
            {t("common.duplicate")}
          </MenuItem>
        )}
        {canCreateView && (
          <MenuItem onClick={() => setIsSaveTemplateOpen(true)}>
            <BookmarkPlusIcon />
            {t("workspaces.views.saveAsTemplate")}
          </MenuItem>
        )}
        {canUpdateView && (
          <MenuSub
            onOpenChange={(open) => {
              if (!open) {
                setConvertPreview(null);
              }
            }}
          >
            <MenuSubTrigger>
              <Icon />
              {t("common.convertTo")}
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuPreviewLayout
                preview={
                  <ViewLayoutPreview
                    kind={convertPreview}
                    workspaceId={workspaceId}
                  />
                }
              >
                {LAYOUT_OPTIONS.flatMap((l) => {
                  if (l === layout.type || l === "overview") {
                    return [];
                  }
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
                              stellaToast.add({
                                title: t("errors.failedToChangeViewType"),
                                type: "error",
                              });
                            },
                          },
                        );
                      }}
                      onFocus={() => setConvertPreview(l)}
                      onMouseEnter={() => setConvertPreview(l)}
                    >
                      <LayoutIcon />
                      {t(LAYOUT_LABEL_KEYS[l])}
                    </MenuItem>
                  );
                })}
              </MenuPreviewLayout>
            </MenuSubPopup>
          </MenuSub>
        )}
        {(canUpdateView || canCreateView) && canDeleteView && <MenuSeparator />}
        {canDeleteView && (
          <MenuItem
            disabled={!canDelete}
            onClick={() => setIsDeleteOpen(true)}
            variant="destructive"
          >
            <Trash2Icon />
            {t("common.delete")}
          </MenuItem>
        )}
      </>
    );
  };

  const contextMenu = useAnchoredMenu({
    children: target ? renderItems(target) : null,
  });

  const openFor = ({ view, canDelete, event }: OpenViewActionsArgs) => {
    if (!hasActions) {
      return;
    }
    setTarget({ view, canDelete });
    contextMenu.openAt(event);
  };

  // The visible three-dot trigger is a real `MenuTrigger`, so Base UI
  // anchors the popup to the button and restores focus to it on close
  // (keyboard/AT included). The cursor-anchored `openFor` path is kept
  // only for right-click on a tab.
  const renderActions = ({ view, canDelete }: ViewActionsTarget) => {
    if (!hasActions) {
      return null;
    }
    return (
      <Menu
        onOpenChange={(open) => {
          if (open) {
            setTarget({ view, canDelete });
          }
        }}
      >
        <MenuTrigger
          aria-label={t("common.actions")}
          render={
            <Button
              className="absolute inset-e-0 top-1/2 -translate-y-1/2"
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <EllipsisVerticalIcon />
        </MenuTrigger>
        <MenuPopup>{renderItems({ view, canDelete })}</MenuPopup>
      </Menu>
    );
  };

  const overlays = (
    <>
      {canCreateView && target && (
        <SaveAsTemplateDialog
          key={target.view.id}
          defaultName={target.view.name}
          layout={target.view.layout}
          onOpenChange={setIsSaveTemplateOpen}
          open={isSaveTemplateOpen}
          workspaceId={workspaceId}
        />
      )}
      {canDeleteView && target && (
        <AlertDialog onOpenChange={setIsDeleteOpen} open={isDeleteOpen}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("workspaces.views.deleteView")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("common.deleteConfirmDescription", {
                  name: target.view.name,
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
                    onClick={() => handleDelete(target.view.id)}
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
      {contextMenu.element}
    </>
  );

  return { openFor, renderActions, overlays };
};
