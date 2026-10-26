import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  FoldHorizontalIcon,
  MinusIcon,
  PlusIcon,
  UnfoldHorizontalIcon,
} from "@stll/ui/icons";

import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";

export type ZoomDirection = "in" | "out";

type ZoomControlsProps = {
  /** The surface is already at its largest step; growing is refused. */
  atMax?: boolean | undefined;
  /** The surface is already at its smallest step; shrinking is refused. */
  atMin?: boolean | undefined;
  /**
   * The current level as a multiple of the surface's own default, where 1 is
   * that default. It decides whether there is anything to reset and which way
   * the reset points.
   */
  level: number;
  onReset: () => void;
  onZoom: (direction: ZoomDirection) => void;
};

const DEFAULT_LEVEL = 1;

/**
 * The minus / plus / reset triad every inspector surface zooms with: the PDF
 * and DOCX viewers, and the readers, which step their text size instead of a
 * page scale. One control so the gesture, the icons and the labels are the
 * same wherever something can be made bigger.
 */
export const ZoomControls = ({
  atMax = false,
  atMin = false,
  level,
  onReset,
  onZoom,
}: ZoomControlsProps) => {
  const t = useTranslations();

  // Icon-only buttons: the label names each one, and the tooltip shows it.
  return (
    <>
      <Button
        aria-label={t("common.zoomOut")}
        disabled={atMin}
        onClick={() => onZoom("out")}
        size="icon-xs"
        variant="ghost"
      >
        <MinusIcon className="size-3" />
      </Button>
      <Button
        aria-label={t("common.zoomIn")}
        disabled={atMax}
        onClick={() => onZoom("in")}
        size="icon-xs"
        variant="ghost"
      >
        <PlusIcon className="size-3" />
      </Button>
      <Button
        aria-label={t("common.resetZoom")}
        disabled={level === DEFAULT_LEVEL}
        onClick={onReset}
        size="icon-xs"
        variant="ghost"
      >
        {level > DEFAULT_LEVEL ? (
          <FoldHorizontalIcon className="size-3" />
        ) : (
          <UnfoldHorizontalIcon className="size-3" />
        )}
      </Button>
    </>
  );
};

type FloatingZoomControlsProps = ZoomControlsProps & {
  /** Controls that share the bar, placed before the zoom triad. */
  children?: ReactNode;
  className?: string | undefined;
};

/**
 * The zoom triad floated in the viewer's corner bar: the one place a reader
 * zooms, in the side panel and on the full page alike. A reader never puts
 * the triad in a header row; it mounts this inside the `relative` box that
 * holds its scroll container.
 */
export const FloatingZoomControls = ({
  children,
  className,
  ...zoom
}: FloatingZoomControlsProps) => (
  <ViewerOverlayBar className={className}>
    {children}
    <ZoomControls {...zoom} />
  </ViewerOverlayBar>
);
