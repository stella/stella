"use client";

import { useEffect } from "react";
import type { ReactElement, ReactNode } from "react";

import { MessageSquarePlusIcon } from "lucide-react";

import { useIsMobile } from "../hooks/use-mobile";
import {
  InspectorRail,
  InspectorRailCell,
  InspectorRailContent,
  InspectorRailFooter,
  InspectorRailIconButton,
} from "../inspector/chrome";
import { SHELL_CHROME_LAYER_CLASS_NAME } from "../lib/overlay-layer";
import { cn } from "../lib/utils";
import { Sheet, SheetPopup, SheetTitle, SheetTrigger } from "./sheet";

type WorkspaceCompactNavigation = {
  /** Navigation content rendered inside Stella's compact sheet. */
  content: ReactElement;
  /** Accessible name shared by the trigger and sheet. */
  label: string;
  /** Controlled sheet state owned by the host application. */
  open: boolean;
  /** Receives close gestures, Escape, backdrop presses, and viewport changes. */
  onOpenChange: (open: boolean) => void;
  /** Host-styled button; null disables compact navigation for single-purpose hosts. */
  trigger: ReactElement | null;
};

type WorkspaceNavigation =
  | {
      /** The host already owns its complete responsive navigation behavior. */
      content: ReactElement;
      mode: "responsive";
    }
  | {
      /** Stella owns the desktop/compact cutoff and compact navigation sheet. */
      compact: WorkspaceCompactNavigation;
      desktop: ReactElement;
      mode: "shell-managed";
    };

type WorkspaceTopBarContext = {
  /** Place this in compact chrome; null when navigation is host-responsive. */
  compactNavigationTrigger: ReactElement | null;
};

type WorkspaceShellProps = {
  /** Product navigation with one explicit responsive ownership mode. */
  navigation: WorkspaceNavigation;
  /** Sticky route chrome; managed navigation exposes its compact trigger here. */
  topBar: (context: WorkspaceTopBarContext) => ReactElement;
  /**
   * Inline-end rail or inspector dock. Omit it and the shell mounts no end
   * dock at all: no rail, none of its inline-end width reservation, and the
   * content column extends to the frame's inline-end edge.
   */
  endDock?: ReactElement | undefined;
  /** Active route content. */
  children: ReactNode;
};

/**
 * Stella's complete authenticated workspace frame. It owns the dynamic
 * viewport, sibling rail geometry, sticky top chrome, and sole content
 * scroller so product routes cannot create an app inside the app.
 *
 * The end dock is optional: a host with nothing to put on the inline-end edge
 * omits it rather than reserving width for an empty rail.
 */
export const WorkspaceShell = ({
  children,
  endDock,
  navigation,
  topBar,
}: WorkspaceShellProps) => {
  const isCompact = useIsMobile();
  const compactNavigation =
    navigation.mode === "shell-managed" ? navigation.compact : null;
  const compactNavigationOpen = compactNavigation?.open ?? false;
  const onCompactNavigationOpenChange = compactNavigation?.onOpenChange;

  useEffect(() => {
    if (!isCompact && compactNavigationOpen) {
      onCompactNavigationOpenChange?.(false);
    }
  }, [compactNavigationOpen, isCompact, onCompactNavigationOpenChange]);

  const compactNavigationTrigger =
    compactNavigation?.trigger === null || compactNavigation === null ? null : (
      <span className="contents md:hidden">
        <SheetTrigger
          aria-label={compactNavigation.label}
          render={compactNavigation.trigger}
        />
      </span>
    );

  const frame = (
    <div
      className="flex h-dvh min-h-0 w-full overflow-hidden"
      data-slot="workspace-shell"
    >
      {navigation.mode === "responsive"
        ? navigation.content
        : navigation.desktop}
      <main
        className={cn(
          "bg-background relative flex w-full min-w-0 flex-1 flex-col overflow-hidden",
          "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2",
        )}
        data-slot="workspace-shell-main"
      >
        <div
          className={cn(
            "bg-background sticky top-0 shrink-0",
            SHELL_CHROME_LAYER_CLASS_NAME,
          )}
          data-slot="workspace-shell-top-bar"
        >
          {topBar({ compactNavigationTrigger })}
        </div>
        <div
          className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain"
          data-slot="workspace-shell-content"
        >
          {children}
        </div>
      </main>
      {endDock}
    </div>
  );

  if (compactNavigation === null) {
    return frame;
  }

  return (
    <Sheet
      open={isCompact && compactNavigation.open}
      onOpenChange={compactNavigation.onOpenChange}
    >
      {frame}
      {isCompact ? (
        <SheetPopup
          className="w-[min(20rem,100vw)]"
          showCloseButton={false}
          side="inline-start"
        >
          <SheetTitle className="sr-only">{compactNavigation.label}</SheetTitle>
          <div
            className="bg-background flex h-full min-h-0 flex-col overflow-y-auto [padding-inline:max(0.75rem,env(safe-area-inset-left))_max(0.75rem,env(safe-area-inset-right))] [padding-block:max(0.75rem,env(safe-area-inset-top))_max(0.75rem,env(safe-area-inset-bottom))]"
            data-slot="workspace-compact-navigation"
          >
            {compactNavigation.content}
          </div>
        </SheetPopup>
      ) : null}
    </Sheet>
  );
};

type WorkspaceEndRailChatAction =
  | {
      label: string;
      onActivate: () => void;
      status: "enabled";
    }
  | {
      label: string;
      reason: string;
      status: "unavailable";
    };

type WorkspaceEndRailProps = {
  /** Accessible name for the complete rail, independent of its chat action. */
  label: string;
  /** Required top-row affordance, such as opening or minimizing a pane. */
  topAction: ReactNode;
  /** Tabs or contextual actions between the two permanent rail rows. */
  children?: ReactNode | undefined;
  /** Portalled menus or overlays that must not become scrolling rail content. */
  overlay?: ReactNode | undefined;
  /**
   * Required by construction: a host either wires a working chat action or
   * exposes an explicit, fail-closed unavailable state with a reason.
   */
  chatAction: WorkspaceEndRailChatAction;
  className?: string | undefined;
};

/**
 * The permanent inline-end workspace rail. Stella owns its width, row rhythm,
 * touch targets, scrolling middle region, and bottom chat position; hosts own
 * only the actions and route state.
 */
export const WorkspaceEndRail = ({
  chatAction,
  children,
  className,
  label,
  overlay,
  topAction,
}: WorkspaceEndRailProps) => (
  <InspectorRail aria-label={label} className={cn("h-dvh", className)}>
    <InspectorRailCell>{topAction}</InspectorRailCell>
    <InspectorRailContent>{children}</InspectorRailContent>
    {overlay}
    <InspectorRailFooter>
      {chatAction.status === "enabled" ? (
        <InspectorRailIconButton
          aria-label={chatAction.label}
          onClick={chatAction.onActivate}
          title={chatAction.label}
        >
          <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
        </InspectorRailIconButton>
      ) : (
        <InspectorRailIconButton
          aria-label={`${chatAction.label}: ${chatAction.reason}`}
          disabled
          title={chatAction.reason}
        >
          <MessageSquarePlusIcon aria-hidden="true" className="size-4" />
        </InspectorRailIconButton>
      )}
    </InspectorRailFooter>
  </InspectorRail>
);

export type {
  WorkspaceCompactNavigation,
  WorkspaceEndRailChatAction,
  WorkspaceEndRailProps,
  WorkspaceNavigation,
  WorkspaceShellProps,
  WorkspaceTopBarContext,
};
