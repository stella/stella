import type { PropsWithChildren } from "react";

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
export const ViewerOverlayBar = ({ children }: PropsWithChildren) => (
  <div className="bg-background/80 supports-[backdrop-filter]:bg-background/65 absolute end-2 top-2 z-10 flex items-center gap-1 rounded-md border p-0.5 shadow-sm backdrop-blur">
    {children}
  </div>
);
