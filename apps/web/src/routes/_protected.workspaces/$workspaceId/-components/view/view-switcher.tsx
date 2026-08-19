import { useState } from "react";

import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
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

import {
  DIRECTLY_CREATABLE_VIEW_LAYOUTS,
  isRequiredViewLayout,
  type RequiredViewLayoutType,
} from "@stll/api-contract";
import type { ViewLayout, ViewLayoutType } from "@stll/api/types";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "@stll/ui/menu";
import { MenuPreviewLayout } from "@stll/ui/preview-pane";
import { Tabs, TabsList, TabsTab } from "@stll/ui/tabs";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { InlineEdit } from "@/components/inline-edit";
import { useAnchoredMenu } from "@/components/inspector/use-anchored-menu";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { usePermissions } from "@/hooks/use-permissions";
import type { TextDirection } from "@/i18n/i18n-store";
import { getLangDir, useI18nStore } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";
import type { WorkspaceView } from "@/lib/types";
import { viewsOptions } from "@/lib/workspaces/queries/views";
import { SaveAsTemplateDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/view/save-as-template-dialog";
import { TemplatePickerDialog } from "@/routes/_protected.workspaces/$workspaceId/-components/view/template-picker-dialog";
import type { ViewLayoutPreviewKind } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-layout-preview";
import { ViewLayoutPreview } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-layout-preview";
import type { ViewDropPosition } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-switcher.logic";
import {
  reorderViewIds,
  toViewDropPosition,
} from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-switcher.logic";
import {
  useConvertView,
  useCreateView,
  useDeleteView,
  useReorderViews,
  useUpdateView,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/views";

const VIEW_DRAG_TYPE = "stella/view-id";

type ViewDropTarget = {
  data: Record<string | symbol, unknown>;
};

// The strip mirrors under RTL, so the nearest physical edge only names a
// position once read against the writing direction.
const resolveDropPosition = (
  { data }: ViewDropTarget,
  direction: TextDirection,
) => toViewDropPosition(extractClosestEdge(data), direction);

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

const emptyLayout = (type: RequiredViewLayoutType): ViewLayout => {
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

const LAYOUT_OPTIONS = DIRECTLY_CREATABLE_VIEW_LAYOUTS;

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
  const [stripContainer, setStripContainer] = useState<HTMLDivElement | null>(
    null,
  );

  // Bounds the tabs' stickiness: a sticky target survives the pointer leaving
  // it only while its parent target is unchanged. Without this the tabs stay
  // sticky page-wide, keeping the insertion line lit over unrelated chrome and
  // reordering on release there. Not sticky itself, so leaving the strip
  // clears the tab with it.
  useExternalSyncEffect(() => {
    if (!stripContainer) {
      return undefined;
    }
    return dropTargetForElements({
      element: stripContainer,
      canDrop: ({ source }) => source.data["type"] === VIEW_DRAG_TYPE,
    });
  }, [stripContainer]);

  const handleReorder = (
    draggedId: string,
    targetId: string,
    position: ViewDropPosition,
  ) => {
    const reordered = reorderViewIds({
      ids: views.map((view) => view.id),
      draggedId,
      targetId,
      position,
    });

    if (!reordered) {
      return;
    }

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
    <div
      className="flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-1 overflow-x-auto px-2 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      ref={setStripContainer}
    >
      <Tabs value={activeViewId}>
        <TabsList variant="underline">
          {views.map((view) => {
            const isLastOfLayout =
              isRequiredViewLayout(view.layout.type) &&
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
                isAnyMenuOpen={viewActions.isAnyMenuOpen}
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
  isAnyMenuOpen: boolean;
  actions: React.ReactNode;
  onSelect: () => void;
  onReorder: (
    draggedId: string,
    targetId: string,
    position: ViewDropPosition,
  ) => void;
  onStartRename: () => void;
  onStopRename: () => void;
  onOpenContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
};

const ViewTab = ({
  workspaceId,
  view,
  isRenaming,
  isAnyMenuOpen,
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
  const [dropPosition, setDropPosition] = useState<ViewDropPosition | null>(
    null,
  );
  const updateView = useUpdateView(workspaceId);
  // Held as state rather than a ref so registration follows the node: the
  // wrapper is replaced whenever the tab enters or leaves rename mode.
  const [tabContainer, setTabContainer] = useState<HTMLDivElement | null>(null);
  const handleReorder = useLatestCallback(onReorder);
  // Read at drag start so opening a menu does not re-register the draggable.
  // A press on the menu's dismiss layer still reaches the tab, and the drag it
  // starts previews that layer instead of the tab. The layer spans the strip,
  // so any open menu gates every tab.
  const canDragTab = useLatestCallback(() => !isAnyMenuOpen);
  const direction = useI18nStore((state) => getLangDir(state.lang));

  // Seed the draft from the current name each time rename begins,
  // since the trigger now lives in the parent (menu or double-click).
  if (isRenaming !== wasRenaming) {
    setWasRenaming(isRenaming);
    if (isRenaming) {
      setRenameValue(name);
    }
  }

  useExternalSyncEffect(() => {
    if (!tabContainer) {
      return undefined;
    }
    return combine(
      ...(canUpdateView
        ? [
            draggable({
              element: tabContainer,
              canDrag: canDragTab,
              getInitialData: () => ({
                type: VIEW_DRAG_TYPE,
                viewId: id,
              }),
            }),
          ]
        : []),
      dropTargetForElements({
        element: tabContainer,
        canDrop: ({ source }) =>
          source.data["type"] === VIEW_DRAG_TYPE &&
          source.data["viewId"] !== id,
        getData: ({ input, element }) =>
          attachClosestEdge(
            { viewId: id },
            { element, input, allowedEdges: ["left", "right"] },
          ),
        // Hold the target while the pointer crosses the gap to the next tab so
        // the insertion line does not flicker. The strip's target bounds it.
        getIsSticky: () => true,
        onDrag: ({ self }) =>
          setDropPosition(resolveDropPosition(self, direction)),
        onDragLeave: () => setDropPosition(null),
        onDrop: ({ source, self }) => {
          setDropPosition(null);
          const draggedViewId = source.data["viewId"];
          const position = resolveDropPosition(self, direction);
          if (typeof draggedViewId !== "string" || position === null) {
            return;
          }
          handleReorder(draggedViewId, id, position);
        },
      }),
    );
  }, [id, canUpdateView, canDragTab, direction, handleReorder, tabContainer]);

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
    <div className="relative" ref={setTabContainer}>
      {dropPosition !== null && (
        <span
          aria-hidden="true"
          // Drawn inside the tab's box rather than in the gap beside it: the
          // tab list is a scroll container, and anything painted outside the
          // box is ink overflow, which the container clips instead of
          // scrolling to. At the strip's ends that would drop the line
          // entirely.
          className={cn(
            "bg-primary pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full",
            dropPosition === "before" ? "start-0" : "end-0",
          )}
        />
      )}
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
  const [isActionsOpen, setIsActionsOpen] = useState(false);
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
          setIsActionsOpen(open);
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
              // The surrounding tab is a draggable; this button is not a drag
              // affordance. Only covers presses on the button itself, which is
              // why the tab separately refuses to drag while the menu is open.
              draggable={false}
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

  // The dismiss layer covers the whole strip, so an open menu anywhere gates
  // dragging on every tab, not just its own.
  const isAnyMenuOpen = isActionsOpen || contextMenu.open;

  return { openFor, renderActions, overlays, isAnyMenuOpen };
};
