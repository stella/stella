import { Fragment, useState } from "react";

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
import { stellaToast } from "@stll/ui/toast";
import { WorkspaceViewSwitcher } from "@stll/workspace-ui/view-switcher";

import {
  withDragAnnouncementData,
  withDropAnnouncementData,
} from "@/components/drag-and-drop-live-region.logic";
import { InlineEdit } from "@/components/inline-edit";
import { useAnchoredMenu } from "@/components/inspector/use-anchored-menu";
import { usePermissions } from "@/hooks/use-permissions";
import { getLangDir, useI18nStore } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";
import type { ViewLayout, ViewLayoutType } from "@/lib/api-contract";
import type { WorkspaceView } from "@/lib/types";
import { viewsOptions } from "@/lib/workspaces/queries/views";
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
    calculations: [],
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
    calculations: [],
    datePropertyId: "_start-date",
    mode: "month",
  },
  timeline: {
    version: 1,
    type: "timeline",
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
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
  const canUpdateView = usePermissions({ view: ["update"] });
  const direction = useI18nStore((state) => getLangDir(state.lang));
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
  const disallowedTemplateLayouts = new Set<ViewLayoutType>(
    hasOverviewView ? ["overview"] : [],
  );
  const handleReorder = (reordered: string[]) => {
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

  const addControl = canCreateView ? (
    <Menu>
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
        <ViewLayoutMenuContent
          options={[
            ...createLayoutOptions.map((layoutType) => ({
              kind: layoutType,
              icon: layoutIcons[layoutType],
              label: t(LAYOUT_LABEL_KEYS[layoutType]),
              onSelect: () => {
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
              },
            })),
            {
              kind: "template",
              icon: BookmarkIcon,
              label: t("workspaces.views.useTemplate"),
              onSelect: () => setIsTemplatePickerOpen(true),
              separatorBefore: true,
            },
          ]}
          workspaceId={workspaceId}
        />
      </MenuPopup>
    </Menu>
  ) : null;

  return (
    <>
      <WorkspaceViewSwitcher
        activeViewId={activeViewId}
        addControl={addControl}
        ariaLabel={t("workspaces.views.switcherLabel")}
        direction={direction}
        editing={
          renamingViewId
            ? {
                viewId: renamingViewId,
                renderLabel: (view) => (
                  <ViewRenameEditor
                    key={view.id}
                    onStop={() =>
                      setRenamingViewId((current) =>
                        current === view.id ? null : current,
                      )
                    }
                    view={view}
                    workspaceId={workspaceId}
                  />
                ),
              }
            : null
        }
        onViewChange={onViewChange}
        onViewContextMenu={(view, event) => {
          const isLastOfLayout =
            isRequiredViewLayout(view.layout.type) &&
            views.filter(
              (candidate) => candidate.layout.type === view.layout.type,
            ).length <= 1;
          viewActions.openFor({
            view,
            canDelete: !isLastOfLayout,
            event,
          });
        }}
        onViewDoubleClick={(view, event) => {
          if (!canUpdateView) {
            return;
          }
          event.preventDefault();
          setRenamingViewId(view.id);
        }}
        renderActions={(view) => {
          if (view.id !== activeViewId) {
            return null;
          }
          const isLastOfLayout =
            isRequiredViewLayout(view.layout.type) &&
            views.filter(
              (candidate) => candidate.layout.type === view.layout.type,
            ).length <= 1;
          return viewActions.renderActions({
            view,
            canDelete: !isLastOfLayout,
          });
        }}
        renderIcon={(view) => {
          const Icon = layoutIcons[view.layout.type];
          return <Icon className="size-3.5 shrink-0" />;
        }}
        reorder={
          canUpdateView
            ? {
                getDragData: (view) => withDragAnnouncementData({}, view.name),
                getDropData: (view) =>
                  withDropAnnouncementData(
                    {},
                    { type: "reorder", name: view.name },
                  ),
                isBlocked: viewActions.isAnyMenuOpen,
                onReorder: handleReorder,
              }
            : null
        }
        views={views}
      />
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
    </>
  );
};

type ViewLayoutMenuOption = {
  kind: ViewLayoutPreviewKind;
  icon: React.ElementType;
  label: string;
  onSelect: () => void;
  separatorBefore?: boolean;
};

type ViewLayoutMenuContentProps = {
  options: ViewLayoutMenuOption[];
  workspaceId: string;
};

const ViewLayoutMenuContent = ({
  options,
  workspaceId,
}: ViewLayoutMenuContentProps) => {
  const [highlightedKind, setHighlightedKind] =
    useState<ViewLayoutPreviewKind | null>(null);
  const previewKind = options.some(({ kind }) => kind === highlightedKind)
    ? highlightedKind
    : (options.at(0)?.kind ?? null);

  return (
    <MenuPreviewLayout
      preview={
        <ViewLayoutPreview kind={previewKind} workspaceId={workspaceId} />
      }
    >
      {options.map(({ kind, icon: Icon, label, onSelect, separatorBefore }) => (
        <Fragment key={kind}>
          {separatorBefore && <MenuSeparator />}
          <MenuItem
            onClick={onSelect}
            onFocus={() => setHighlightedKind(kind)}
            onMouseEnter={() => setHighlightedKind(kind)}
          >
            <Icon />
            {label}
          </MenuItem>
        </Fragment>
      ))}
    </MenuPreviewLayout>
  );
};

type ViewRenameEditorProps = {
  workspaceId: string;
  view: WorkspaceView;
  onStop: () => void;
};

const ViewRenameEditor = ({
  workspaceId,
  view,
  onStop,
}: ViewRenameEditorProps) => {
  const { id, name } = view;
  const t = useTranslations();
  const [renameValue, setRenameValue] = useState(name);
  const updateView = useUpdateView(workspaceId);

  const handleRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed === name) {
      onStop();
      setRenameValue(name);
      return;
    }

    updateView.mutate(
      { viewId: id, name: trimmed },
      {
        onSuccess: onStop,
        onError: () => {
          stellaToast.add({
            title: t("errors.failedToRenameView"),
            type: "error",
          });
          onStop();
          setRenameValue(name);
        },
      },
    );
  };

  return (
    <InlineEdit
      inputClassName="w-24"
      onCancel={() => {
        onStop();
        setRenameValue(name);
      }}
      onChange={setRenameValue}
      onCommit={handleRename}
      value={renameValue}
    />
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
          <MenuSub>
            <MenuSubTrigger>
              <Icon />
              {t("common.convertTo")}
            </MenuSubTrigger>
            <MenuSubPopup>
              <ViewLayoutMenuContent
                options={LAYOUT_OPTIONS.flatMap((layoutType) => {
                  if (layoutType === layout.type || layoutType === "overview") {
                    return [];
                  }
                  return [
                    {
                      kind: layoutType,
                      icon: layoutIcons[layoutType],
                      label: t(LAYOUT_LABEL_KEYS[layoutType]),
                      onSelect: () => {
                        convertView.mutate(
                          {
                            viewId: id,
                            targetType: layoutType,
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
                      },
                    },
                  ];
                })}
                workspaceId={workspaceId}
              />
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
