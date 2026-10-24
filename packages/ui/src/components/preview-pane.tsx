import type * as React from "react";

import { cn } from "../lib/utils";

/**
 * Side-pane preview pattern: a list of options (menu items, rows) with a
 * fixed-width pane beside it that previews the highlighted option. The pane
 * stays mounted so the container never resizes mid-interaction; drive it
 * from `onMouseEnter`/`onFocus` on the options and render `PreviewPane`
 * empty (no children) while nothing is highlighted.
 */

type MenuPreviewLayoutProps = React.PropsWithChildren<{
  preview: React.ReactNode;
  className?: string;
  /**
   * `fixed` sizes the menu around a fixed-width pane. `remaining` is for a
   * menu whose width is set from outside: the pane takes the width the
   * options leave and is dropped below 10rem, so it never paints past the
   * menu. Pair it with a `PreviewPane` of `w-full`.
   */
  previewWidth?: "fixed" | "remaining";
}>;

const MenuPreviewLayout = ({
  children,
  preview,
  className,
  previewWidth = "fixed",
}: MenuPreviewLayoutProps) => (
  <div
    className={cn("flex items-stretch", className)}
    data-slot="menu-preview-layout"
  >
    <div
      className={cn(
        "flex min-w-32 flex-col",
        previewWidth === "fixed" ? "flex-1" : "shrink-0",
      )}
    >
      {children}
    </div>
    {previewWidth === "fixed" ? (
      <div className="ms-1 hidden border-s ps-1 sm:block">{preview}</div>
    ) : (
      <div className="@container min-w-0 flex-1">
        <div className="ms-1 hidden border-s ps-1 @min-[10rem]:block">
          {preview}
        </div>
      </div>
    )}
  </div>
);

type PreviewPaneProps = React.ComponentProps<"div"> & {
  /**
   * `default` is the side pane described above. `thumbnail` is the same pane
   * shrunk to sit inline inside a card or list row beside its own label.
   */
  size?: "default" | "thumbnail";
};

const PreviewPane = ({
  children,
  className,
  size = "default",
  ...props
}: PreviewPaneProps) => (
  <div
    className={cn(
      "pointer-events-none select-none",
      size === "thumbnail" ? "w-32" : "w-64 p-2",
      className,
    )}
    data-slot="preview-pane"
    {...props}
  >
    <div
      aria-hidden
      className={cn(
        "bg-muted/40 overflow-hidden rounded-md border",
        size === "thumbnail" ? "h-20 p-1.5" : "h-36 p-2",
      )}
    >
      {children}
    </div>
  </div>
);

export { MenuPreviewLayout, PreviewPane };
