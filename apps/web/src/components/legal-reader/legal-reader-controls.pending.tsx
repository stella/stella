import type { ComponentProps } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { MinusIcon, PlusIcon, UnfoldHorizontalIcon } from "@stll/ui/icons";

import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";

/**
 * `--reader-margin-width` is the width of a notes column the reader draws at
 * the layout's inline start, zero where it draws none. The controls bar
 * starts past it: the bar belongs to the text, and its glass must not cover
 * the notes beside it.
 */
export const LEGAL_READER_LAYOUT_CLASS_NAME =
  "relative [--reader-margin-width:0px] [--reader-controls-inset:--spacing(2)] [--reader-controls-height:--spacing(12)] [--reader-controls-clearance:calc(var(--reader-controls-inset)+var(--reader-controls-height)+var(--reader-controls-inset))]";
export const LEGAL_READER_CONTENT_CLEARANCE_CLASS_NAME =
  "pt-(--reader-controls-clearance)";

/** Where the controls bar floats: past the notes column, along the top. */
export const LEGAL_READER_CONTROLS_BAR_CLASS_NAME =
  "reader-chrome start-[calc(var(--reader-margin-width)+var(--reader-controls-inset))] top-(--reader-controls-inset) h-(--reader-controls-height) min-w-0 gap-0 text-xs";

/**
 * The page canvas a full-page reader's document column takes: the width,
 * centring and inline gutters `reader.css` gives `reader-document-column`,
 * as utilities, so a loading reader drawn before that stylesheet arrives
 * already stands in the column the text will fill.
 */
export const READER_PAGE_COLUMN_CLASS_NAME =
  "mx-auto w-full max-w-7xl px-4 max-sm:px-3";

/**
 * The reader's scroll container. The document is a canvas that scrolls
 * natively, under the reader's thin scrollbar (`reader.css`), so its gutter
 * is the same while the text loads and once it is there.
 */
export const ReaderScrollViewport = ({
  children,
  ...props
}: ComponentProps<"div">) => (
  <div {...props} className="reader-scroll h-full overflow-y-auto">
    {children}
  </div>
);

/**
 * The controls bar before its reader mounts: the glass bar where it floats,
 * an empty breadcrumb (the trail follows the scroll position, and there is
 * no text to scroll yet) and the zoom triad's faces, unavailable.
 */
export const LegalReaderControlsPending = () => (
  <ViewerOverlayBar className={LEGAL_READER_CONTROLS_BAR_CLASS_NAME}>
    <div className="relative min-w-0 flex-1" />
    <ButtonFace size="icon-xs" variant="ghost">
      <MinusIcon className="size-3" />
    </ButtonFace>
    <ButtonFace size="icon-xs" variant="ghost">
      <PlusIcon className="size-3" />
    </ButtonFace>
    <ButtonFace size="icon-xs" variant="ghost">
      <UnfoldHorizontalIcon className="size-3" />
    </ButtonFace>
  </ViewerOverlayBar>
);
