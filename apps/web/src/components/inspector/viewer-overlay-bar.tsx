import type { PropsWithChildren } from "react";

import { cn } from "@stll/ui/utils";

/**
 * The glass bar a viewer's controls float in, pinned to the top inline-end
 * corner of the document: the PDF and DOCX preview, the search preview, and
 * the legal readers. One owner of the corner, the glass and the spacing, so
 * the surfaces cannot drift apart.
 *
 * Positioned against the nearest positioned ancestor, so the caller mounts it
 * as a sibling of the scroll container inside a `relative` box. It sits under
 * the annotation toolbar and the chat composer, which anchor to the opposite
 * edge and win any overlap.
 */
export const ViewerOverlayBar = ({
  children,
  className,
}: PropsWithChildren<{ className?: string | undefined }>) => (
  <div
    className={cn(
      "bg-background/80 supports-[backdrop-filter]:bg-background/65 absolute end-2 top-2 z-10 flex items-center gap-1 rounded-md border p-0.5 shadow-sm backdrop-blur",
      className,
    )}
  >
    {children}
  </div>
);

/**
 * Block-start space a reader's document column leaves above its first row,
 * so at the top of the scroll nothing the reader prints sits under the bar,
 * whatever that row is and however it aligns. The bar's inset plus its own
 * height, with a gap; the text scrolls under the glass after that. Every
 * reader that floats the bar starts its column with this, not a number of
 * its own.
 */
export const VIEWER_OVERLAY_BAR_TOP_CLEARANCE = "pt-12";
