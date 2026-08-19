import type { ReactNode } from "react";

import { useRouterState } from "@tanstack/react-router";
import { MessageSquarePlusIcon, PanelRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import {
  SIDE_RAIL_CONTAINER_CLASS,
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";

/** Reading width of an expanded public inspector pane, in pixels. */
export const PUBLIC_INSPECTOR_PANE_WIDTH = 420;

/**
 * Anonymous twin of the inspector side rail: same geometry and chrome as the
 * authenticated rail, with every affordance routed to sign-in.
 */
export const PublicInspectorRail = ({
  requestSignIn,
}: {
  requestSignIn: (redirectTo: string) => void;
}) => {
  const t = useTranslations();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });

  const railButton = ({ icon, label, edgeClass }: RailButtonOptions) => (
    <div
      className={cn(
        "flex w-full shrink-0 items-center justify-center",
        edgeClass,
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <Tooltip
        content={label}
        render={
          <button
            aria-label={label}
            className={cn(
              "text-muted-foreground hover:bg-accent hover:text-foreground flex items-center justify-center rounded-md transition-colors",
              SIDE_RAIL_ICON_BUTTON_SIZE,
            )}
            onClick={() => requestSignIn(currentHref)}
            type="button"
          />
        }
      >
        {icon}
      </Tooltip>
    </div>
  );

  return (
    <PublicInspectorDock>
      <div className="bg-background flex h-full shadow-lg">
        <div className={SIDE_RAIL_CONTAINER_CLASS}>
          {railButton({
            icon: <PanelRightIcon className="size-4" />,
            label: t("inspector.showPane"),
            edgeClass: "border-b",
          })}
          <div className="flex-1" />
          {railButton({
            icon: <MessageSquarePlusIcon className="size-4" />,
            label: t("inspector.openChat"),
            edgeClass: "border-t",
          })}
        </div>
      </div>
    </PublicInspectorDock>
  );
};

type PublicInspectorDockProps = {
  children: ReactNode;
  /** Widened to the pane while a tab is on screen; a bare rail otherwise. */
  expanded?: boolean;
};

/**
 * The column a public surface docks its inspector into. It reserves its own
 * width in the flow, so the reading column beside it is never covered. Narrow
 * viewports get no dock at all: there the reader owns the whole screen.
 */
export const PublicInspectorDock = ({
  children,
  expanded = false,
}: PublicInspectorDockProps) => {
  const width = expanded ? { width: PUBLIC_INSPECTOR_PANE_WIDTH } : undefined;

  return (
    <div
      className="text-sidebar-foreground hidden md:block"
      data-side="right"
      data-state={expanded ? "expanded" : "collapsed"}
    >
      <div
        className={cn("bg-sidebar relative", !expanded && SIDE_RAIL_WIDTH)}
        style={width}
      />
      <div
        className={cn(
          "fixed inset-y-0 end-0 z-10 hidden h-svh md:flex",
          !expanded && SIDE_RAIL_WIDTH,
        )}
        style={width}
      >
        <div className="bg-sidebar flex h-full w-full flex-col">{children}</div>
      </div>
    </div>
  );
};

type RailButtonOptions = {
  icon: ReactNode;
  label: string;
  edgeClass: string;
};
