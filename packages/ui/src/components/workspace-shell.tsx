import type { ReactElement, ReactNode } from "react";

import { MessageSquarePlusIcon } from "lucide-react";

import {
  InspectorRail,
  InspectorRailCell,
  InspectorRailContent,
  InspectorRailFooter,
  InspectorRailIconButton,
} from "../inspector/chrome";
import { cn } from "../lib/utils";

type WorkspaceShellProps = {
  /** Product navigation in Stella's inline-start application column. */
  navigation: ReactElement;
  /** Sticky route chrome above the sole scrolling content surface. */
  topBar: ReactElement;
  /** Permanent inline-end rail or inspector dock. */
  endDock: ReactElement;
  /** Active route content. */
  children: ReactNode;
};

/**
 * Stella's complete authenticated workspace frame. It owns the dynamic
 * viewport, sibling rail geometry, sticky top chrome, and sole content
 * scroller so product routes cannot create an app inside the app.
 */
export const WorkspaceShell = ({
  children,
  endDock,
  navigation,
  topBar,
}: WorkspaceShellProps) => (
  <div
    className="flex h-dvh min-h-0 w-full overflow-hidden"
    data-slot="workspace-shell"
  >
    {navigation}
    <main
      className={cn(
        "bg-background relative flex w-full min-w-0 flex-1 flex-col overflow-hidden",
        "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2",
      )}
      data-slot="workspace-shell-main"
    >
      <div
        className="bg-background sticky top-0 z-20 shrink-0"
        data-slot="workspace-shell-top-bar"
      >
        {topBar}
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto overscroll-contain"
        data-slot="workspace-shell-content"
      >
        {children}
      </div>
    </main>
    {endDock}
  </div>
);

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
  WorkspaceEndRailChatAction,
  WorkspaceEndRailProps,
  WorkspaceShellProps,
};
