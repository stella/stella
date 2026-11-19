"use client";

import type { ComponentProps, ReactNode, Ref } from "react";

import { BidiText } from "@stll/ui/bidi-text";
import type { InlineDirection } from "@stll/ui/inline-reorder";
import { TOOLBAR_ROW_HEIGHT } from "@stll/ui/layout-tokens";
import { Tabs, TabsList, TabsTab } from "@stll/ui/tabs";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

export type WorkspaceViewSwitcherItem = {
  id: string;
  name: string;
};

export type WorkspaceViewStripProps = {
  activeViewId: string;
  ariaLabel: string;
  direction: InlineDirection;
  addControl?: ReactNode;
  onViewChange?: (viewId: string) => void;
  /** The element that holds the tabs, for a drop target around them. */
  stripRef?: Ref<HTMLDivElement>;
  children: ReactNode;
};

/**
 * The saved-view strip without behaviour: one toolbar row of underline tabs
 * and, after them, the add control. `WorkspaceViewSwitcher` renders its tabs
 * inside it; a loading view renders `WorkspaceViewSwitcherFace` in the same
 * strip, so the row does not move when the switcher takes over.
 */
export const WorkspaceViewStrip = ({
  activeViewId,
  ariaLabel,
  direction,
  addControl,
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
    <div className="h-full min-w-0 flex-1" ref={stripRef}>
      <Tabs
        className="h-full gap-0"
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
    </div>
    {addControl === null || addControl === undefined ? null : (
      <div className="border-border flex shrink-0 translate-y-1 items-center border-s ps-1">
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

/** A view's name on its tab, cut short at a fixed width. */
export const WorkspaceViewTabName = ({ name }: { name: string }) => (
  <TruncatedText
    className="max-w-36 whitespace-pre"
    render={<BidiText as="span" />}
  >
    {name}
  </TruncatedText>
);

export type WorkspaceViewSwitcherFaceProps<
  View extends WorkspaceViewSwitcherItem,
> = {
  activeViewId: string;
  ariaLabel: string;
  direction: InlineDirection;
  views: readonly View[];
  renderIcon: (view: View) => ReactNode;
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
  reserveActionSpace,
  addControl,
}: WorkspaceViewSwitcherFaceProps<View>) => (
  <WorkspaceViewStrip
    activeViewId={activeViewId}
    addControl={addControl}
    ariaLabel={ariaLabel}
    direction={direction}
  >
    {views.map((view) => (
      <div className="relative flex h-full items-center" key={view.id}>
        <WorkspaceViewTabFace
          reserveActionSpace={reserveActionSpace}
          value={view.id}
        >
          {renderIcon(view)}
          <WorkspaceViewTabName name={view.name} />
        </WorkspaceViewTabFace>
      </div>
    ))}
  </WorkspaceViewStrip>
);
