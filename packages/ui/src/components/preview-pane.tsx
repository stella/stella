import type * as React from "react";

import { cn } from "@stll/ui/lib/utils";

/**
 * Side-pane preview pattern: a list of options (menu items, rows) with a
 * fixed-width pane beside it that previews the highlighted option. The pane
 * stays mounted so the container never resizes mid-interaction; drive it
 * from `onMouseEnter`/`onFocus` on the options and render `PreviewPane`
 * empty (no children) while nothing is highlighted.
 */

function MenuPreviewLayout({
  children,
  preview,
  className,
}: React.PropsWithChildren<{
  preview: React.ReactNode;
  className?: string;
}>) {
  return (
    <div
      className={cn("flex items-stretch", className)}
      data-slot="menu-preview-layout"
    >
      <div className="flex min-w-32 flex-1 flex-col">{children}</div>
      <div className="ms-1 hidden border-s ps-1 sm:block">{preview}</div>
    </div>
  );
}

function PreviewPane({
  children,
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("pointer-events-none w-64 p-2 select-none", className)}
      data-slot="preview-pane"
      {...props}
    >
      <div
        aria-hidden
        className="bg-muted/40 h-36 overflow-hidden rounded-md border p-2"
      >
        {children}
      </div>
    </div>
  );
}

export { MenuPreviewLayout, PreviewPane };
