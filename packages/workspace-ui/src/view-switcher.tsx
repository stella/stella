"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { attachClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge";
import { extractClosestEdge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";

import { Button } from "@stll/ui/button";
import { EllipsisVerticalIcon } from "@stll/ui/icons";
import { InlineDropIndicator } from "@stll/ui/inline-drop-indicator";
import {
  type InlineDirection,
  type InlineDropPosition,
  reorderInlineIds,
  toInlineDropPosition,
} from "@stll/ui/inline-reorder";
import { Menu, MenuPopup, MenuTrigger } from "@stll/ui/menu";

import {
  WorkspaceViewStrip,
  type WorkspaceViewSwitcherItem,
  WorkspaceViewTabFace,
  WorkspaceViewTabName,
} from "./view-switcher-face";

export type { WorkspaceViewSwitcherItem } from "./view-switcher-face";

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
    direction: InlineDirection;
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
    actionMenu?: {
      label: string;
      renderItems: (view: View) => React.ReactNode;
      onOpenChange?: (view: View, open: boolean) => void;
    };
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
  actionMenu,
  renderIcon,
}: WorkspaceViewSwitcherProps<View>) => {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const canReorder = reorder !== null;
  const viewTabs = views.map((view) => {
    const items = actionMenu?.renderItems(view);
    const hasItems =
      items !== null && items !== undefined && typeof items !== "boolean";
    return {
      view,
      actions:
        actionMenu && hasItems ? (
          <Menu
            onOpenChange={(open) => {
              setOpenMenuId((currentId) => {
                if (open) {
                  return view.id;
                }
                return currentId === view.id ? null : currentId;
              });
              actionMenu.onOpenChange?.(view, open);
            }}
          >
            <MenuTrigger
              aria-label={actionMenu.label}
              render={
                <Button draggable={false} size="icon-xs" variant="ghost" />
              }
            >
              <EllipsisVerticalIcon />
            </MenuTrigger>
            <MenuPopup>{items}</MenuPopup>
          </Menu>
        ) : null,
    };
  });
  const reserveActionSpace = viewTabs.some(({ actions }) => actions !== null);
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
    position: InlineDropPosition,
  ) => {
    const reordered = reorderInlineIds({
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
    <WorkspaceViewStrip
      activeViewId={activeViewId}
      addControl={addControl}
      ariaLabel={ariaLabel}
      direction={direction}
      onViewChange={onViewChange}
      stripRef={setStripContainer}
    >
      {viewTabs.map(({ view, actions }) => {
        if (editing?.viewId === view.id) {
          return (
            <WorkspaceViewTabFace
              key={view.id}
              nativeButton={false}
              render={<div />}
              reserveActionSpace={reserveActionSpace}
              value={view.id}
            >
              {renderIcon(view)}
              {editing.renderLabel(view)}
            </WorkspaceViewTabFace>
          );
        }

        return (
          <WorkspaceViewTab
            actions={actions}
            canReorder={canReorder}
            direction={direction}
            getDragData={reorder?.getDragData}
            getDropData={reorder?.getDropData}
            isDragBlocked={openMenuId !== null || (reorder?.isBlocked ?? false)}
            instanceId={instanceId}
            key={view.id}
            onContextMenu={onViewContextMenu}
            onDoubleClick={onViewDoubleClick}
            onReorder={handleReorder}
            renderIcon={renderIcon}
            reserveActionSpace={reserveActionSpace}
            view={view}
          />
        );
      })}
    </WorkspaceViewStrip>
  );
};

type WorkspaceViewTabProps<View extends WorkspaceViewSwitcherItem> = {
  actions: React.ReactNode | undefined;
  canReorder: boolean;
  direction: InlineDirection;
  getDragData: ((view: View) => Record<string | symbol, unknown>) | undefined;
  getDropData: ((view: View) => Record<string | symbol, unknown>) | undefined;
  isDragBlocked: boolean;
  instanceId: symbol;
  onContextMenu:
    ((view: View, event: React.MouseEvent<HTMLElement>) => void) | undefined;
  onDoubleClick:
    ((view: View, event: React.MouseEvent<HTMLElement>) => void) | undefined;
  onReorder: (
    draggedId: string,
    targetId: string,
    position: InlineDropPosition,
  ) => void;
  renderIcon: (view: View) => React.ReactNode;
  reserveActionSpace: boolean;
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
  reserveActionSpace,
  view,
}: WorkspaceViewTabProps<View>) => {
  const [tabContainer, setTabContainer] = useState<HTMLDivElement | null>(null);
  const [dropPosition, setDropPosition] = useState<InlineDropPosition | null>(
    null,
  );
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
            toInlineDropPosition(extractClosestEdge(self.data), direction),
          ),
        onDragLeave: () => setDropPosition(null),
        onDrop: ({ source, self }) => {
          setDropPosition(null);
          const draggedId = source.data[VIEW_DRAG_ID];
          const position = toInlineDropPosition(
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
    <div className="relative flex h-full items-center" ref={setTabContainer}>
      <InlineDropIndicator position={dropPosition} />
      <WorkspaceViewTabFace
        onContextMenu={(event) => onContextMenu?.(view, event)}
        onDoubleClick={(event) => onDoubleClick?.(view, event)}
        reserveActionSpace={reserveActionSpace}
        value={view.id}
      >
        {renderIcon(view)}
        <WorkspaceViewTabName name={view.name} />
      </WorkspaceViewTabFace>
      {actions === null || actions === undefined ? null : (
        <div className="absolute inset-e-0 top-1/2 mt-1 -translate-y-1/2">
          {actions}
        </div>
      )}
    </div>
  );
};
