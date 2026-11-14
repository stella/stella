import type * as React from "react";

import { cn } from "../lib/utils";
import { ScrollArea } from "./scroll-area";

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

/**
 * What the pane does with content taller than its box. `clip` is for a
 * depiction (a sketch, a scaled glimpse of a page) that only has to show its
 * shape. `scroll` is for text the reader may need to the last line, such as
 * the exact words a copy choice writes: the box keeps its size and scrolls
 * vertically, so wheel and trackpad reach the end. A scrolling pane takes
 * pointer events and, once it overflows, a place in the tab order so the
 * keyboard reaches the end too; being reachable, it is not hidden from
 * assistive technology.
 */
type PreviewPaneOverflow = "clip" | "scroll";

type PreviewPaneProps = React.ComponentProps<"div"> & {
  overflow?: PreviewPaneOverflow;
  /**
   * `default` is the side pane described above. `thumbnail` is the same pane
   * shrunk to sit inline inside a card or list row beside its own label.
   */
  size?: "default" | "thumbnail";
};

const PREVIEW_BOX_CLASS = "bg-muted/40 rounded-md border";

const PreviewPane = ({
  children,
  className,
  overflow = "clip",
  size = "default",
  ...props
}: PreviewPaneProps) => (
  <div
    className={cn(
      "select-none",
      overflow === "clip" && "pointer-events-none",
      size === "thumbnail" ? "w-32" : "w-64 p-2",
      className,
    )}
    data-slot="preview-pane"
    {...props}
  >
    {overflow === "scroll" ? (
      <ScrollArea
        axis="vertical"
        className={cn(
          PREVIEW_BOX_CLASS,
          size === "thumbnail" ? "h-20" : "h-36",
        )}
        data-slot="preview-pane-scroll"
        // Scrolling the pane must not take focus or the reader's text
        // selection away from the options it previews.
        onMouseDown={(event) => event.preventDefault()}
        scrollFade
      >
        <div className={size === "thumbnail" ? "p-1.5" : "p-2"}>{children}</div>
      </ScrollArea>
    ) : (
      <div
        aria-hidden
        className={cn(
          PREVIEW_BOX_CLASS,
          "overflow-hidden",
          size === "thumbnail" ? "h-20 p-1.5" : "h-36 p-2",
        )}
      >
        {children}
      </div>
    )}
  </div>
);

export { MenuPreviewLayout, PreviewPane };
