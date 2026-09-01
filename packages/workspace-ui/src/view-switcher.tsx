"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  attachClosestEdge,
  extractClosestEdge,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";

import { Tabs, TabsList, TabsTab } from "@stll/ui/tabs";
import { cn } from "@stll/ui/utils";

import {
  reorderWorkspaceViewIds,
  toWorkspaceViewDropPosition,
  type WorkspaceViewDirection,
  type WorkspaceViewDropPosition,
} from "./view-switcher.logic";

const VIEW_DRAG_TYPE = "@stll/workspace-ui/view-switcher/drag-type";
const VIEW_DRAG_ID = "@stll/workspace-ui/view-switcher/view-id";
const VIEW_DRAG_INSTANCE = "@stll/workspace-ui/view-switcher/instance";

const useLatestCallback = <Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): ((...args: Args) => Result) => {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  // Library-contract memoization: drag registrations require stable callbacks
  // that still read the latest committed host state.
  return useCallback((...args: Args) => latest.current(...args), []);
};

export type WorkspaceViewSwitcherItem = {
  id: string;
  name: string;
};

export type WorkspaceViewSwitcherEditing<View> = {
  viewId: string;
  renderLabel: (view: View) => React.ReactNode;
};

export type WorkspaceViewSwitcherReorder<View> = {
  getDragData?: (view: View) => Record<string | symbol, unknown>;
  getDropData?: (view: View) => Record<string | symbol, unknown>;
  isBlocked?: boolean;
  onReorder: (viewIds: string[]) => void;
};

export type WorkspaceViewSwitcherProps<View extends WorkspaceViewSwitcherItem> =
  {
    activeViewId: string;
    ariaLabel: string;
    direction: WorkspaceViewDirection;
    reorder: WorkspaceViewSwitcherReorder<View> | null;
    views: readonly View[];
    addControl?: React.ReactNode;
    editing?: WorkspaceViewSwitcherEditing<View> | null;
    onViewChange: (viewId: string) => void;
    onViewContextMenu?: (
      view: View,
      event: React.MouseEvent<HTMLElement>,
    ) => void;
    onViewDoubleClick?: (
      view: View,
      event: React.MouseEvent<HTMLElement>,
    ) => void;
    renderActions?: (view: View) => React.ReactNode;
    renderIcon: (view: View) => React.ReactNode;
  };

export const WorkspaceViewSwitcher = <View extends WorkspaceViewSwitcherItem>({
  activeViewId,
  ariaLabel,
  direction,
  reorder,
  views,
  addControl,
  editing,
  onViewChange,
  onViewContextMenu,
  onViewDoubleClick,
  renderActions,
  renderIcon,
}: WorkspaceViewSwitcherProps<View>) => {
  const canReorder = reorder !== null;
  const [instanceId] = useState(Symbol);
  const [stripContainer, setStripContainer] = useState<HTMLDivElement | null>(
    null,
  );

  useEffect(() => {
    if (!stripContainer || !canReorder) {
      return undefined;
    }

    return dropTargetForElements({
      element: stripContainer,
      canDrop: ({ source }) =>
        source.data[VIEW_DRAG_TYPE] === true &&
        source.data[VIEW_DRAG_INSTANCE] === instanceId,
    });
  }, [canReorder, instanceId, stripContainer]);

  const handleReorder = (
    draggedId: string,
    targetId: string,
    position: WorkspaceViewDropPosition,
  ) => {
    const reordered = reorderWorkspaceViewIds({
      ids: views.map((view) => view.id),
      draggedId,
      targetId,
      position,
    });

    if (reordered) {
      reorder?.onReorder(reordered);
    }
  };

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1 px-2"
      dir={direction}
    >
      <div className="min-w-0 flex-1" ref={setStripContainer}>
        <Tabs
          onValueChange={(value) => {
            if (typeof value === "string") {
              onViewChange(value);
            }
          }}
          value={activeViewId}
        >
          <TabsList aria-label={ariaLabel} variant="underline">
            {views.map((view) => {
              if (editing?.viewId === view.id) {
                return (
                  <TabsTab
                    key={view.id}
                    nativeButton={false}
                    render={<div />}
                    value={view.id}
                  >
                    {renderIcon(view)}
                    {editing.renderLabel(view)}
                  </TabsTab>
                );
              }

              return (
                <WorkspaceViewTab
                  actions={renderActions?.(view)}
                  canReorder={canReorder}
                  direction={direction}
                  getDragData={reorder?.getDragData}
                  getDropData={reorder?.getDropData}
                  isDragBlocked={reorder?.isBlocked ?? false}
                  instanceId={instanceId}
                  key={view.id}
                  onContextMenu={onViewContextMenu}
                  onDoubleClick={onViewDoubleClick}
                  onReorder={handleReorder}
                  renderIcon={renderIcon}
                  view={view}
                />
              );
            })}
          </TabsList>
        </Tabs>
      </div>
      {addControl}
    </div>
  );
};

type WorkspaceViewTabProps<View extends WorkspaceViewSwitcherItem> = {
  actions: React.ReactNode | undefined;
  canReorder: boolean;
  direction: WorkspaceViewDirection;
  getDragData: ((view: View) => Record<string | symbol, unknown>) | undefined;
  getDropData: ((view: View) => Record<string | symbol, unknown>) | undefined;
  isDragBlocked: boolean;
  instanceId: symbol;
  onContextMenu:
    | ((view: View, event: React.MouseEvent<HTMLElement>) => void)
    | undefined;
  onDoubleClick:
    | ((view: View, event: React.MouseEvent<HTMLElement>) => void)
    | undefined;
  onReorder: (
    draggedId: string,
    targetId: string,
    position: WorkspaceViewDropPosition,
  ) => void;
  renderIcon: (view: View) => React.ReactNode;
  view: View;
};

const WorkspaceViewTab = <View extends WorkspaceViewSwitcherItem>({
  actions,
  canReorder,
  direction,
  getDragData,
  getDropData,
  isDragBlocked,
  instanceId,
  onContextMenu,
  onDoubleClick,
  onReorder,
  renderIcon,
  view,
}: WorkspaceViewTabProps<View>) => {
  const [tabContainer, setTabContainer] = useState<HTMLDivElement | null>(null);
  const [dropPosition, setDropPosition] =
    useState<WorkspaceViewDropPosition | null>(null);
  const canDrag = useLatestCallback(() => !isDragBlocked);
  const initialData = useLatestCallback(() => ({
    ...getDragData?.(view),
    [VIEW_DRAG_TYPE]: true,
    [VIEW_DRAG_ID]: view.id,
    [VIEW_DRAG_INSTANCE]: instanceId,
  }));
  const dropData = useLatestCallback(() => ({
    ...getDropData?.(view),
    [VIEW_DRAG_ID]: view.id,
  }));
  const reorder = useLatestCallback(onReorder);

  useEffect(() => {
    if (!tabContainer) {
      return undefined;
    }

    return combine(
      ...(canReorder
        ? [
            draggable({
              element: tabContainer,
              canDrag,
              getInitialData: initialData,
            }),
          ]
        : []),
      dropTargetForElements({
        element: tabContainer,
        canDrop: ({ source }) =>
          canReorder &&
          source.data[VIEW_DRAG_TYPE] === true &&
          source.data[VIEW_DRAG_INSTANCE] === instanceId &&
          source.data[VIEW_DRAG_ID] !== view.id,
        getData: ({ input, element }) =>
          attachClosestEdge(dropData(), {
            element,
            input,
            allowedEdges: ["left", "right"],
          }),
        getIsSticky: () => true,
        onDrag: ({ self }) =>
          setDropPosition(
            toWorkspaceViewDropPosition(
              extractClosestEdge(self.data),
              direction,
            ),
          ),
        onDragLeave: () => setDropPosition(null),
        onDrop: ({ source, self }) => {
          setDropPosition(null);
          const draggedId = source.data[VIEW_DRAG_ID];
          const position = toWorkspaceViewDropPosition(
            extractClosestEdge(self.data),
            direction,
          );
          if (typeof draggedId === "string" && position) {
            reorder(draggedId, view.id, position);
          }
        },
      }),
    );
  }, [
    canReorder,
    direction,
    canDrag,
    dropData,
    initialData,
    instanceId,
    reorder,
    tabContainer,
    view.id,
  ]);

  return (
    <div className="relative flex items-center" ref={setTabContainer}>
      {dropPosition !== null && (
        <span
          aria-hidden="true"
          className={cn(
            "bg-primary pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full",
            dropPosition === "before" ? "start-0" : "end-0",
          )}
        />
      )}
      <TabsTab
        className={
          actions === null || actions === undefined ? undefined : "pe-6.5"
        }
        onContextMenu={(event) => onContextMenu?.(view, event)}
        onDoubleClick={(event) => onDoubleClick?.(view, event)}
        value={view.id}
      >
        {renderIcon(view)}
        <span className="max-w-36 truncate">{view.name}</span>
      </TabsTab>
      {actions === null || actions === undefined ? null : (
        <div className="absolute inset-e-0 top-1/2 -translate-y-1/2">
          {actions}
        </div>
      )}
    </div>
  );
};
