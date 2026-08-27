import type { ReactNode } from "react";

import { cn } from "../lib/utils";

type ApplicationShellProps = {
  /**
   * The application navigation surface. It stays a direct sibling of the
   * content column so sidebar implementations can reserve their own width.
   */
  sidebar: ReactNode;
  /** The route chrome rendered above the application content. */
  header?: ReactNode | undefined;
  /** An optional dock or rail at the inline-end edge. */
  inspector?: ReactNode | undefined;
  /** The active route or page content. */
  children: ReactNode;
  className?: string | undefined;
  mainClassName?: string | undefined;
};

/**
 * The three-column application frame: navigation, page chrome and content,
 * then an optional inline-end inspector. Product navigation, route state, and
 * inspector behaviour stay in the host; this primitive only owns the layout
 * relationship that lets those surfaces share a viewport without nesting one
 * inside another.
 */
export const ApplicationShell = ({
  children,
  className,
  header,
  inspector,
  mainClassName,
  sidebar,
}: ApplicationShellProps) => (
  <div
    className={cn("flex min-h-svh w-full", className)}
    data-slot="application-shell"
  >
    {sidebar}
    <main
      className={cn(
        "bg-background relative flex w-full flex-1 flex-col overflow-hidden",
        "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ms-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2",
        mainClassName,
      )}
      data-slot="application-shell-main"
    >
      {header}
      {children}
    </main>
    {inspector}
  </div>
);

export type { ApplicationShellProps };
