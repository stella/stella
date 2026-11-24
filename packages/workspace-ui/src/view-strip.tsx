"use client";

import type { ComponentProps, ReactNode, Ref } from "react";

import { BidiText } from "@stll/ui/bidi-text";
import type { InlineDirection } from "@stll/ui/inline-reorder";
import { TOOLBAR_ROW_HEIGHT } from "@stll/ui/layout-tokens";
import { Tabs, TabsList, TabsTab } from "@stll/ui/tabs";
import { TRUNCATED_TEXT_LINES_CLASS } from "@stll/ui/truncated-text-face";
import { cn } from "@stll/ui/utils";

export type WorkspaceViewSwitcherItem = {
  id: string;
  name: string;
};

export type WorkspaceViewStripProps = {
  activeViewId: string;
  ariaLabel: string;
  /** The strip's reading direction; the document's when left out. */
  direction?: InlineDirection | undefined;
  addControl?: ReactNode;
  /**
   * Drawn right after the tabs, in the room they share: the menu that holds
   * the views the strip has no room for, and the copy it measures them by.
   */
  overflowControl?: ReactNode;
  onViewChange?: (viewId: string) => void;
  /**
   * The row the tabs and the overflow control share: its width is the room
   * the switcher fits tabs into, and it is the drop target around them.
   */
  stripRef?: Ref<HTMLDivElement>;
  children: ReactNode;
};

/**
 * The saved-view strip without behaviour: one toolbar row of underline tabs,
 * the overflow menu right after them when some views have no room, and the
 * add control at the row's end. `WorkspaceViewSwitcher` renders its tabs
 * inside it; a loading view renders `WorkspaceViewSwitcherFace` in the same
 * strip, so the row does not move when the switcher takes over.
 *
 * The tabs never scroll: the switcher moves the views that do not fit into
 * the overflow menu, so no divider is needed to set the add control apart
 * from a scrolling strip.
 */
export const WorkspaceViewStrip = ({
  activeViewId,
  ariaLabel,
  direction,
  addControl,
  overflowControl,
  onViewChange,
  stripRef,
  children,
}: WorkspaceViewStripProps) => (
  <div
    // The strip is one toolbar row, the same height as the top bar above
    // it and a kanban column header below it, whatever the tabs render.
    className={cn(
      "flex min-w-0 flex-1 items-center gap-1 px-2",
      TOOLBAR_ROW_HEIGHT,
    )}
    data-slot="workspace-view-switcher"
    dir={direction}
  >
    <div
      className="relative flex h-full min-w-0 flex-1 items-center gap-0.5"
      ref={stripRef}
    >
      <Tabs
        className="h-full min-w-0 gap-0"
        onValueChange={(value) => {
          if (typeof value === "string") {
            onViewChange?.(value);
          }
        }}
        value={activeViewId}
      >
        <TabsList
          aria-label={ariaLabel}
          className="h-full data-[orientation=horizontal]:py-0"
          variant="underline"
        >
          {children}
        </TabsList>
      </Tabs>
      {overflowControl}
    </div>
    {addControl === null || addControl === undefined ? null : (
      <div className="flex shrink-0 translate-y-1 items-center">
        {addControl}
      </div>
    )}
  </div>
);

export type WorkspaceViewTabFaceProps = Omit<
  ComponentProps<typeof TabsTab>,
  "className"
> & {
  /** Room at the end of each tab for the active tab's action menu. */
  reserveActionSpace: boolean;
};

/** One view's tab, sized the same with or without its behaviour. */
export const WorkspaceViewTabFace = ({
  reserveActionSpace,
  ...props
}: WorkspaceViewTabFaceProps) => (
  <TabsTab
    {...props}
    className={cn(
      "h-full pt-2 sm:h-full",
      reserveActionSpace ? "pe-6.5" : undefined,
    )}
  />
);

/** A view's name on its tab: the width at which it is cut short. */
export const WORKSPACE_VIEW_TAB_NAME_CLASS = "max-w-36 whitespace-pre";

/** A view's name on its tab before the switcher mounts: the same box, cut
 *  short the same way, with no hint that shows the whole name. */
export const WorkspaceViewTabNameFace = ({ name }: { name: string }) => (
  <BidiText
    as="span"
    className={cn(TRUNCATED_TEXT_LINES_CLASS[1], WORKSPACE_VIEW_TAB_NAME_CLASS)}
    data-slot="truncated-text"
  >
    {name}
  </BidiText>
);

export type WorkspaceViewSwitcherFaceProps<
  View extends WorkspaceViewSwitcherItem,
> = {
  activeViewId: string;
  ariaLabel: string;
  /** The strip's reading direction; the document's when left out. */
  direction?: InlineDirection | undefined;
  views: readonly View[];
  renderIcon: (view: View) => ReactNode;
  /**
   * A view's name in its tab's name box, for a name the caller draws itself
   * (one that waits on the app's messages); `null`, or no callback, draws
   * the view's own name.
   */
  renderName?: ((view: View) => ReactNode) | undefined;
  reserveActionSpace: boolean;
  addControl?: ReactNode;
};

/**
 * The strip as it looks before its behaviour has loaded: the same tabs, names
 * and icons, with no reordering, menus or renaming.
 */
export const WorkspaceViewSwitcherFace = <
  View extends WorkspaceViewSwitcherItem,
>({
  activeViewId,
  ariaLabel,
  direction,
  views,
  renderIcon,
  renderName,
  reserveActionSpace,
  addControl,
}: WorkspaceViewSwitcherFaceProps<View>) => (
  <WorkspaceViewStrip
    activeViewId={activeViewId}
    addControl={addControl}
    ariaLabel={ariaLabel}
    direction={direction}
  >
    {views.map((view) => {
      const name = renderName?.(view) ?? null;
      return (
        <div className="relative flex h-full items-center" key={view.id}>
          <WorkspaceViewTabFace
            reserveActionSpace={reserveActionSpace}
            value={view.id}
          >
            {renderIcon(view)}
            {name === null ? (
              <WorkspaceViewTabNameFace name={view.name} />
            ) : (
              <span
                className={cn(
                  TRUNCATED_TEXT_LINES_CLASS[1],
                  WORKSPACE_VIEW_TAB_NAME_CLASS,
                )}
                data-slot="truncated-text"
              >
                {name}
              </span>
            )}
          </WorkspaceViewTabFace>
        </div>
      );
    })}
  </WorkspaceViewStrip>
);
