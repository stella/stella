import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";

// A tool's detail panel in both phases (a pending-safe module): the loaded
// panel renders these frames with the tool, a pending view with placeholders.

/** The panel: its title bar, the scrolling body and the actions' bar. */
export const ToolDetailPanelFrame = ({
  header,
  body,
  bodyClassName,
  footer,
  children,
}: {
  /** The title bar's contents: the name, its links and the close button. */
  header: ReactNode;
  body: ReactNode;
  /** How the loaded body scrolls; the pending one does not. */
  bodyClassName?: string | undefined;
  /** The actions' bar renders only when given. */
  footer?: ReactNode;
  /** Dialogs the route owns. */
  children?: ReactNode;
}) => (
  <div className="flex h-full min-h-0 w-full flex-col">
    <header
      className={cn(
        "border-border flex shrink-0 items-center gap-2 border-b px-3",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      {header}
    </header>
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-5 px-3 py-4",
        bodyClassName,
      )}
    >
      {body}
    </div>
    {footer !== undefined && (
      <footer
        className={cn(
          "border-border flex shrink-0 items-center gap-2 border-t px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        {footer}
      </footer>
    )}
    {children}
  </div>
);

/** One of the panel's sections under its small caption. */
export const ToolDetailSection = ({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex flex-col gap-2.5">
    <h3 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
      {title}
    </h3>
    {children}
  </section>
);
